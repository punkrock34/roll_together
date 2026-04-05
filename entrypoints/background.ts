import { browser, type Browser } from "wxt/browser";

import {
  CONTENT_PORT_NAME,
  POPUP_PORT_NAME,
  type BackgroundOutboundMessage,
  type ContentOutboundMessage,
  type PopupRequestMessage,
  type PopupStateResponse,
  type RoomConnectionStatus,
} from "../src/core/messages";
import {
  PROTOCOL_VERSION,
  type JoinMessage,
  type PingMessage,
  parseServerMessage,
  type PlaybackSnapshot,
  type ServerMessage,
  type SyncMessage,
} from "../src/core/protocol";
import {
  DEFAULT_SETTINGS,
  getSettings,
  getWatchProgressForEpisode,
  listRecentRooms,
  upsertRecentRoom,
  upsertWatchProgress,
} from "../src/core/storage";
import { buildRoomInviteUrl, getRoomIdFromUrl } from "../src/core/url";
import { isCrunchyrollUrl } from "../src/providers/crunchyroll/player";
import {
  normalizePlaybackSnapshotForTab,
  resolveRoomIdForTabContext,
} from "../src/providers/crunchyroll/session";

interface TabSession {
  tabId: number;
  ports: Map<number, Browser.runtime.Port>;
  activeFrameId?: number;
  tabUrl?: string;
  tabTitle?: string;
  playback?: PlaybackSnapshot;
  roomIdFromUrl?: string | null;
  roomId?: string;
  sessionId?: string;
  participantCount: number;
  connectionState: RoomConnectionStatus;
  lastError?: string;
  socket?: WebSocket;
  pingInterval?: ReturnType<typeof setInterval>;
  reconnectTimeout?: ReturnType<typeof setTimeout>;
  cleanupTimeout?: ReturnType<typeof setTimeout>;
  autoJoinSuppressedRoomId?: string;
}

const DEFAULT_ACTION_TITLE = "Roll Together v2";

function makeRoomStateMessage(session: TabSession): BackgroundOutboundMessage {
  return {
    type: "background:room-state",
    connectionState: session.connectionState,
    roomId: session.roomId,
    participantCount: session.participantCount,
    lastError: session.lastError,
  };
}

export default defineBackground({
  type: "module",
  main() {
    const sessions = new Map<number, TabSession>();

    const getOrCreateSession = (tabId: number): TabSession => {
      const existing = sessions.get(tabId);
      if (existing) {
        return existing;
      }

      const created: TabSession = {
        tabId,
        ports: new Map<number, Browser.runtime.Port>(),
        participantCount: 1,
        connectionState: "ready",
      };
      sessions.set(tabId, created);
      return created;
    };

    const postToContent = (
      session: TabSession,
      message: BackgroundOutboundMessage,
    ) => {
      const port = getActivePort(session);
      if (!port) {
        return;
      }

      try {
        port.postMessage(message);
      } catch (error) {
        if (!isIgnorablePortError(error)) {
          console.error("Failed to post to content script", error);
        }
      }
    };

    const getActivePort = (
      session: TabSession,
    ): Browser.runtime.Port | undefined => {
      if (session.activeFrameId !== undefined) {
        return session.ports.get(session.activeFrameId);
      }

      return session.ports.values().next().value;
    };

    const publishRoomState = (session: TabSession) => {
      updateActionState(session);
      postToContent(session, makeRoomStateMessage(session));
    };

    const updateActionState = (session: TabSession) => {
      const title = getActionTitle(session);
      const badgeText = getActionBadgeText(session);

      runActionUpdate(
        browser.action.setTitle({
          tabId: session.tabId,
          title,
        }),
      );

      runActionUpdate(
        browser.action.setBadgeText({
          tabId: session.tabId,
          text: badgeText,
        }),
      );

      if (!badgeText) {
        return;
      }

      runActionUpdate(
        browser.action.setBadgeBackgroundColor({
          tabId: session.tabId,
          color: getActionBadgeColor(session),
        }),
      );
    };

    const clearActionState = (tabId: number) => {
      runActionUpdate(
        browser.action.setTitle({
          tabId,
          title: DEFAULT_ACTION_TITLE,
        }),
      );
      runActionUpdate(
        browser.action.setBadgeText({
          tabId,
          text: "",
        }),
      );
    };

    const stopPing = (session: TabSession) => {
      if (session.pingInterval) {
        clearInterval(session.pingInterval);
        session.pingInterval = undefined;
      }
    };

    const stopReconnect = (session: TabSession) => {
      if (session.reconnectTimeout) {
        clearTimeout(session.reconnectTimeout);
        session.reconnectTimeout = undefined;
      }
    };

    const closeSocket = (
      session: TabSession,
      options: {
        clearRoom: boolean;
        clearIdentity: boolean;
        suppressReconnect: boolean;
        sendLeave: boolean;
      },
    ) => {
      stopPing(session);
      stopReconnect(session);

      const socket = session.socket as
        | (WebSocket & { __rtSuppressReconnect?: boolean })
        | undefined;
      session.socket = undefined;

      if (socket) {
        socket.__rtSuppressReconnect = options.suppressReconnect;
        if (options.sendLeave && socket.readyState === WebSocket.OPEN) {
          socket.send(
            JSON.stringify({ type: "leave", version: PROTOCOL_VERSION }),
          );
        }
        socket.close();
      }

      if (options.clearRoom) {
        session.roomId = undefined;
        session.participantCount = 1;
      }

      if (options.clearIdentity) {
        session.sessionId = undefined;
      }
    };

    const scheduleReconnect = (session: TabSession, roomId: string) => {
      stopReconnect(session);
      session.reconnectTimeout = setTimeout(() => {
        if (!getActivePort(session) || !session.playback) {
          return;
        }
        void connectSession(session, roomId);
      }, 1500);
    };

    const connectSession = async (
      session: TabSession,
      requestedRoomId?: string,
    ) => {
      if (!session.playback) {
        return;
      }

      const settings = await getSettings();

      closeSocket(session, {
        clearRoom: false,
        clearIdentity: false,
        suppressReconnect: true,
        sendLeave: false,
      });

      session.connectionState = "connecting";
      session.lastError = undefined;
      publishRoomState(session);

      const socket = new WebSocket(settings.backendWsUrl) as WebSocket & {
        __rtSuppressReconnect?: boolean;
      };
      session.socket = socket;

      socket.addEventListener("open", () => {
        if (session.socket !== socket || !session.playback) {
          return;
        }

        const joinMessage: JoinMessage = {
          type: "join",
          version: PROTOCOL_VERSION,
          roomId: requestedRoomId,
          sessionId: session.sessionId,
          playback: session.playback,
        };

        socket.send(JSON.stringify(joinMessage));

        session.pingInterval = setInterval(() => {
          if (socket.readyState !== WebSocket.OPEN) {
            return;
          }

          const pingMessage: PingMessage = {
            type: "ping",
            version: PROTOCOL_VERSION,
            sentAt: Date.now(),
          };

          socket.send(JSON.stringify(pingMessage));
        }, 20_000);
      });

      socket.addEventListener("message", async (event) => {
        if (session.socket !== socket || typeof event.data !== "string") {
          return;
        }

        const message = parseServerMessage(event.data);
        if (!message) {
          return;
        }

        await handleServerMessage(session, message);
      });

      socket.addEventListener("error", () => {
        if (session.socket !== socket) {
          return;
        }

        session.connectionState = "error";
        session.lastError = "Unable to reach the Roll Together backend.";
        publishRoomState(session);
      });

      socket.addEventListener("close", () => {
        stopPing(session);

        if (session.socket === socket) {
          session.socket = undefined;
        }

        if (socket.__rtSuppressReconnect) {
          return;
        }

        if (!getActivePort(session)) {
          return;
        }

        const reconnectRoomId = session.roomId ?? requestedRoomId;
        if (reconnectRoomId) {
          session.connectionState = "connecting";
          publishRoomState(session);
          scheduleReconnect(session, reconnectRoomId);
        }
      });
    };

    const handleServerMessage = async (
      session: TabSession,
      message: ServerMessage,
    ) => {
      switch (message.type) {
        case "joined": {
          session.connectionState = "connected";
          session.roomId = message.roomId;
          session.sessionId = message.sessionId;
          session.participantCount = message.participantCount;
          session.lastError = undefined;
          session.playback = message.playback;

          const shareUrl =
            session.tabUrl && session.roomId
              ? buildRoomInviteUrl(session.tabUrl, session.roomId)
              : undefined;

          if (shareUrl) {
            await upsertRecentRoom({
              roomId: session.roomId,
              shareUrl,
              episodeTitle: message.playback.episodeTitle,
              episodeUrl: message.playback.episodeUrl,
              updatedAt: Date.now(),
            });
          }

          postToContent(session, {
            type: "background:apply-remote",
            roomId: message.roomId,
            participantCount: message.participantCount,
            playback: message.playback,
          });
          publishRoomState(session);
          break;
        }
        case "sync":
          session.participantCount = message.participantCount;
          session.playback = message.playback;
          postToContent(session, {
            type: "background:apply-remote",
            roomId: message.roomId,
            participantCount: message.participantCount,
            playback: message.playback,
          });
          publishRoomState(session);
          break;
        case "presence":
          session.participantCount = message.participantCount;
          publishRoomState(session);
          break;
        case "pong":
          break;
        case "error":
          session.connectionState = "error";
          session.lastError = message.message;
          publishRoomState(session);
          break;
      }
    };

    const maybeAutoJoin = (session: TabSession) => {
      if (!session.playback || !session.roomIdFromUrl) {
        return;
      }

      if (session.autoJoinSuppressedRoomId === session.roomIdFromUrl) {
        return;
      }

      if (
        session.connectionState === "connected" &&
        session.roomId === session.roomIdFromUrl
      ) {
        return;
      }

      if (session.connectionState === "connecting") {
        return;
      }

      void connectSession(session, session.roomIdFromUrl);
    };

    const handleContentSnapshot = async (
      session: TabSession,
      message: ContentOutboundMessage,
      port: Browser.runtime.Port,
    ) => {
      const senderTabUrl = port.sender?.tab?.url;
      const senderTabTitle = port.sender?.tab?.title;
      const normalizedPlayback = normalizePlaybackSnapshotForTab(
        message.playback,
        senderTabUrl,
        senderTabTitle,
      );

      session.activeFrameId = port.sender?.frameId ?? 0;
      session.tabUrl = senderTabUrl ?? session.tabUrl ?? message.tabUrl;
      session.tabTitle = senderTabTitle ?? session.tabTitle;
      session.playback = normalizedPlayback;
      session.roomIdFromUrl = resolveRoomIdForTabContext(
        senderTabUrl ?? session.tabUrl ?? message.tabUrl,
        message.roomIdFromUrl ?? getRoomIdFromUrl(message.tabUrl),
      );

      if (
        session.autoJoinSuppressedRoomId &&
        session.roomIdFromUrl !== session.autoJoinSuppressedRoomId
      ) {
        session.autoJoinSuppressedRoomId = undefined;
      }

      await upsertWatchProgress(normalizedPlayback);

      if (session.socket?.readyState === WebSocket.OPEN && session.roomId) {
        const syncMessage: SyncMessage = {
          type: "sync",
          version: PROTOCOL_VERSION,
          playback: normalizedPlayback,
        };
        session.socket.send(JSON.stringify(syncMessage));
      } else {
        session.connectionState = "ready";
      }

      maybeAutoJoin(session);
      publishRoomState(session);
    };

    const handlePopupMessage = async (
      message: PopupRequestMessage,
    ): Promise<PopupStateResponse | undefined> => {
      switch (message.type) {
        case "popup:get-active-tab-state": {
          const activeTab = (
            await browser.tabs.query({
              active: true,
              currentWindow: true,
            })
          )[0];
          const settings = await getSettings();
          const recentRooms = await listRecentRooms();

          if (!activeTab?.id) {
            return {
              supported: false,
              providerReady: false,
              connectionState: "unsupported",
              participantCount: 0,
              backendWsUrl: settings.backendWsUrl,
              recentRooms,
            };
          }

          const session = sessions.get(activeTab.id);
          const supported =
            typeof activeTab.url === "string" &&
            isCrunchyrollUrl(activeTab.url);
          const shareUrl =
            activeTab.url && session?.roomId
              ? buildRoomInviteUrl(activeTab.url, session.roomId)
              : undefined;

          return {
            activeTabId: activeTab.id,
            activeTabUrl: activeTab.url,
            supported,
            providerReady: Boolean(session?.playback),
            connectionState: supported
              ? (session?.connectionState ?? "ready")
              : "unsupported",
            roomId: session?.roomId,
            shareUrl,
            participantCount: session?.participantCount ?? 0,
            episodeTitle: session?.playback?.episodeTitle,
            backendWsUrl: settings.backendWsUrl,
            recentRooms: recentRooms.slice(0, 5),
            watchProgress: await getWatchProgressForEpisode(
              session?.playback?.episodeUrl,
            ),
            lastError: session?.lastError,
          };
        }
        case "popup:create-room": {
          const session = sessions.get(message.tabId);
          if (session?.playback) {
            session.autoJoinSuppressedRoomId = undefined;
            await connectSession(session);
          }
          return handlePopupMessage({ type: "popup:get-active-tab-state" });
        }
        case "popup:disconnect-room": {
          const session = sessions.get(message.tabId);
          if (session) {
            session.autoJoinSuppressedRoomId =
              session.roomIdFromUrl ?? session.roomId;
            closeSocket(session, {
              clearRoom: true,
              clearIdentity: true,
              suppressReconnect: true,
              sendLeave: true,
            });
            session.connectionState = "ready";
            session.lastError = undefined;
            publishRoomState(session);
          }
          return handlePopupMessage({ type: "popup:get-active-tab-state" });
        }
      }
    };

    const safeHandlePopupMessage = async (
      message: PopupRequestMessage,
    ): Promise<PopupStateResponse> => {
      try {
        const response = await handlePopupMessage(message);
        if (response) {
          return response;
        }
      } catch (error) {
        console.error("Failed to handle popup message", error);
      }

      const settings = await getSettings();
      const recentRooms = await listRecentRooms();
      return {
        supported: false,
        providerReady: false,
        connectionState: "unsupported",
        participantCount: 0,
        backendWsUrl: settings.backendWsUrl,
        recentRooms: recentRooms.slice(0, 5),
        lastError: "Unable to read extension state.",
      };
    };

    browser.runtime.onInstalled.addListener(() => {
      void browser.storage.local.get("settings").then((stored) => {
        if (!stored.settings) {
          return browser.storage.local.set({ settings: DEFAULT_SETTINGS });
        }
        return undefined;
      });
    });

    browser.runtime.onMessage.addListener((message: PopupRequestMessage) => {
      return safeHandlePopupMessage(message);
    });

    browser.runtime.onConnect.addListener((port) => {
      if (port.name === POPUP_PORT_NAME) {
        port.onMessage.addListener((message: PopupRequestMessage) => {
          void safeHandlePopupMessage(message).then((response) => {
            try {
              port.postMessage(response);
            } catch (error) {
              console.error("Failed to respond to popup port", error);
            }
          });
        });
        return;
      }

      if (port.name !== CONTENT_PORT_NAME) {
        return;
      }

      const tabId = port.sender?.tab?.id;
      const tabUrl = port.sender?.tab?.url;
      const tabTitle = port.sender?.tab?.title;
      const frameId = port.sender?.frameId ?? 0;

      if (!tabId) {
        return;
      }

      const session = getOrCreateSession(tabId);
      session.ports.set(frameId, port);
      session.tabUrl = tabUrl;
      session.tabTitle = tabTitle;
      session.connectionState = session.roomId ? "connected" : "ready";

      if (session.cleanupTimeout) {
        clearTimeout(session.cleanupTimeout);
        session.cleanupTimeout = undefined;
      }

      publishRoomState(session);

      port.onMessage.addListener((message: ContentOutboundMessage) => {
        void handleContentSnapshot(session, message, port);
      });

      port.onDisconnect.addListener(() => {
        session.ports.delete(frameId);
        if (session.activeFrameId === frameId) {
          session.activeFrameId = undefined;
        }

        if (session.ports.size > 0) {
          return;
        }

        session.cleanupTimeout = setTimeout(() => {
          if (session.ports.size > 0) {
            return;
          }

          closeSocket(session, {
            clearRoom: true,
            clearIdentity: false,
            suppressReconnect: true,
            sendLeave: true,
          });
          sessions.delete(tabId);
          clearActionState(tabId);
        }, 3000);
      });
    });
  },
});

function runActionUpdate(update: Promise<unknown>) {
  void update.catch((error) => {
    if (!isIgnorableTabLifecycleError(error)) {
      console.error("Failed to update extension action state", error);
    }
  });
}

function isIgnorableTabLifecycleError(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";

  return message.includes("No tab with id");
}

function isIgnorablePortError(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";

  return (
    message.includes("Extension context invalidated") ||
    message.includes("disconnected port") ||
    message.includes("message channel is closed")
  );
}

function getActionBadgeText(session: TabSession): string {
  if (session.connectionState === "connected") {
    return session.participantCount > 9
      ? "9+"
      : `${Math.max(session.participantCount, 1)}`;
  }

  if (session.connectionState === "connecting") {
    return "...";
  }

  if (session.connectionState === "error") {
    return "!";
  }

  if (session.playback) {
    return "ON";
  }

  return "";
}

function getActionBadgeColor(session: TabSession): string {
  if (session.connectionState === "connected") {
    return "#f97316";
  }

  if (session.connectionState === "connecting") {
    return "#f59e0b";
  }

  if (session.connectionState === "error") {
    return "#ef4444";
  }

  return "#22c55e";
}

function getActionTitle(session: TabSession): string {
  if (session.connectionState === "connected" && session.roomId) {
    return `Roll Together v2: Connected to ${session.roomId.slice(0, 8)} with ${session.participantCount} viewer${session.participantCount === 1 ? "" : "s"}`;
  }

  if (session.connectionState === "connecting") {
    return "Roll Together v2: Connecting to room";
  }

  if (session.connectionState === "error") {
    return `Roll Together v2: ${session.lastError ?? "Connection issue"}`;
  }

  if (session.playback?.episodeTitle) {
    return `Roll Together v2: Player detected for ${session.playback.episodeTitle}`;
  }

  return DEFAULT_ACTION_TITLE;
}
