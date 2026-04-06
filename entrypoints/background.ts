import { browser, type Browser } from "wxt/browser";

import {
  CONTENT_PORT_NAME,
  POPUP_PORT_NAME,
  type ApplyRemotePlaybackMessage,
  type ContentOutboundMessage,
  type PopupRequestMessage,
  type PopupStateResponse,
  type RoomConnectionStatus,
} from "../src/core/messages";
import {
  PROTOCOL_VERSION,
  type JoinMessage,
  type NavigateMessage,
  parseServerMessage,
  type PingMessage,
  type PlaybackSnapshot,
  type ServerMessage,
  type SyncMessage,
} from "../src/core/protocol";
import {
  DEFAULT_SETTINGS,
  getSettings,
  getWatchProgressForEpisode,
  listRecentRooms,
  type ExtensionSettings,
  upsertRecentRoom,
  upsertWatchProgress,
} from "../src/core/storage";
import {
  arePlaybackSnapshotsSimilar,
  buildSyncDecision,
} from "../src/core/reconcile";
import { buildRoomInviteUrl, getRoomIdFromUrl } from "../src/core/url";
import { isCrunchyrollUrl } from "../src/providers/crunchyroll/player";
import {
  didEpisodeChange,
  normalizePlaybackSnapshotForTab,
  resolveRoomIdForTabContext,
} from "../src/providers/crunchyroll/session";

interface TabSession {
  tabId: number;
  ports: Map<number, Browser.runtime.Port>;
  activeFrameId?: number;
  tabUrl?: string;
  tabTitle?: string;
  localPlayback?: PlaybackSnapshot;
  roomPlayback?: PlaybackSnapshot;
  roomIdFromUrl?: string | null;
  roomId?: string;
  sessionId?: string;
  hostSessionId?: string;
  participantCount: number;
  connectionState: RoomConnectionStatus;
  lastError?: string;
  socket?: WebSocket;
  pingInterval?: ReturnType<typeof setInterval>;
  reconnectTimeout?: ReturnType<typeof setTimeout>;
  cleanupTimeout?: ReturnType<typeof setTimeout>;
  autoJoinSuppressedRoomId?: string;
  lastOutboundPlayback?: PlaybackSnapshot;
  lastOutboundAt?: number;
}

const DEFAULT_ACTION_TITLE = "Roll Together";
const NAVIGATION_CLEANUP_TIMEOUT_MS = 12_000;
const DISCONNECTED_CLEANUP_TIMEOUT_MS = 3_000;
const HOST_HEARTBEAT_INTERVAL_MS = 1_500;

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

    const getActivePort = (
      session: TabSession,
    ): Browser.runtime.Port | undefined => {
      if (session.activeFrameId !== undefined) {
        return session.ports.get(session.activeFrameId);
      }

      return session.ports.values().next().value;
    };

    const postToContent = (
      session: TabSession,
      message: ApplyRemotePlaybackMessage,
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

    const publishRoomState = (session: TabSession) => {
      updateActionState(session);
    };

    const updateActionState = (session: TabSession) => {
      runActionUpdate(
        browser.action.setTitle({
          tabId: session.tabId,
          title: getActionTitle(session),
        }),
      );

      const badgeText = getActionBadgeText(session);
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
        session.hostSessionId = undefined;
        session.roomPlayback = undefined;
        session.participantCount = 1;
      }

      if (options.clearIdentity) {
        session.sessionId = undefined;
      }
    };

    const scheduleReconnect = (session: TabSession, roomId: string) => {
      stopReconnect(session);
      session.reconnectTimeout = setTimeout(() => {
        if (!getActivePort(session) || !session.localPlayback) {
          return;
        }
        void connectSession(session, roomId);
      }, 1_500);
    };

    const connectSession = async (
      session: TabSession,
      requestedRoomId?: string,
    ) => {
      if (!session.localPlayback) {
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
        if (session.socket !== socket || !session.localPlayback) {
          return;
        }

        const joinMessage: JoinMessage = {
          type: "join",
          version: PROTOCOL_VERSION,
          roomId: requestedRoomId,
          sessionId: session.sessionId,
          playback: session.localPlayback,
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

    const navigateTabToPlayback = (
      session: TabSession,
      playback: PlaybackSnapshot,
      roomId: string,
    ) => {
      const targetUrl = buildRoomInviteUrl(playback.episodeUrl, roomId);
      session.connectionState = "switching";
      session.lastError = undefined;
      session.roomPlayback = playback;
      session.tabUrl = targetUrl;
      publishRoomState(session);

      void browser.tabs
        .update(session.tabId, { url: targetUrl })
        .catch((error) => {
          if (!isIgnorableTabLifecycleError(error)) {
            console.error("Failed to navigate room tab", error);
          }
        });
    };

    const sendRoomUpdate = (
      session: TabSession,
      type: "sync" | "navigate",
      playback: PlaybackSnapshot,
    ) => {
      if (!session.socket || session.socket.readyState !== WebSocket.OPEN) {
        return;
      }

      const payload: SyncMessage | NavigateMessage =
        type === "navigate"
          ? {
              type,
              version: PROTOCOL_VERSION,
              playback,
            }
          : {
              type,
              version: PROTOCOL_VERSION,
              playback,
            };

      session.socket.send(JSON.stringify(payload));
      session.roomPlayback = playback;
      session.lastOutboundPlayback = playback;
      session.lastOutboundAt = Date.now();
    };

    const shouldSendHostUpdate = (
      session: TabSession,
      previousPlayback: PlaybackSnapshot | undefined,
      nextPlayback: PlaybackSnapshot,
      reason: ContentOutboundMessage["reason"],
    ): "sync" | "navigate" | undefined => {
      if (!session.roomId || !session.sessionId || !session.hostSessionId) {
        return undefined;
      }

      if (session.hostSessionId !== session.sessionId) {
        return undefined;
      }

      if (didEpisodeChange(previousPlayback, nextPlayback)) {
        return "navigate";
      }

      if (reason === "heartbeat") {
        if (nextPlayback.state !== "playing") {
          return undefined;
        }

        const enoughTimePassed =
          !session.lastOutboundAt ||
          Date.now() - session.lastOutboundAt >= HOST_HEARTBEAT_INTERVAL_MS;
        if (
          enoughTimePassed &&
          !arePlaybackSnapshotsSimilar(
            session.lastOutboundPlayback,
            nextPlayback,
            0.15,
          )
        ) {
          return "sync";
        }

        return undefined;
      }

      if (
        !arePlaybackSnapshotsSimilar(
          session.lastOutboundPlayback,
          nextPlayback,
          0.05,
        )
      ) {
        return "sync";
      }

      return undefined;
    };

    const handleFollowerCorrection = (
      session: TabSession,
      playback: PlaybackSnapshot,
      reason: ContentOutboundMessage["reason"],
    ) => {
      if (!session.roomId || !session.roomPlayback || reason === "heartbeat") {
        return;
      }

      const decision = buildSyncDecision(playback, session.roomPlayback);
      if (
        playback.episodeUrl !== session.roomPlayback.episodeUrl ||
        decision.shouldPause ||
        decision.shouldPlay ||
        decision.shouldSeek
      ) {
        postToContent(session, {
          type: "background:apply-remote",
          roomId: session.roomId,
          participantCount: session.participantCount,
          hostSessionId: session.hostSessionId ?? "",
          playback: session.roomPlayback,
        });
      }
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
          session.hostSessionId = message.hostSessionId;
          session.participantCount = message.participantCount;
          session.lastError = undefined;
          session.roomPlayback = message.playback;

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

          if (
            session.localPlayback &&
            !arePlaybackSnapshotsSimilar(
              session.localPlayback,
              message.playback,
              0.2,
            )
          ) {
            postToContent(session, {
              type: "background:apply-remote",
              roomId: message.roomId,
              participantCount: message.participantCount,
              hostSessionId: message.hostSessionId,
              playback: message.playback,
            });
          }

          publishRoomState(session);
          break;
        }
        case "sync":
          session.connectionState = "connected";
          session.participantCount = message.participantCount;
          session.hostSessionId = message.hostSessionId;
          session.roomPlayback = message.playback;
          session.lastError = undefined;
          postToContent(session, {
            type: "background:apply-remote",
            roomId: message.roomId,
            participantCount: message.participantCount,
            hostSessionId: message.hostSessionId,
            playback: message.playback,
          });
          publishRoomState(session);
          break;
        case "navigate":
          session.roomId = message.roomId;
          session.participantCount = message.participantCount;
          session.hostSessionId = message.hostSessionId;
          session.roomPlayback = message.playback;
          session.lastError = undefined;

          await upsertRecentRoom({
            roomId: message.roomId,
            shareUrl: buildRoomInviteUrl(
              message.playback.episodeUrl,
              message.roomId,
            ),
            episodeTitle: message.playback.episodeTitle,
            episodeUrl: message.playback.episodeUrl,
            updatedAt: Date.now(),
          });

          if (
            session.localPlayback?.episodeUrl === message.playback.episodeUrl
          ) {
            session.connectionState = "connected";
            postToContent(session, {
              type: "background:apply-remote",
              roomId: message.roomId,
              participantCount: message.participantCount,
              hostSessionId: message.hostSessionId,
              playback: message.playback,
            });
          } else {
            navigateTabToPlayback(session, message.playback, message.roomId);
          }
          publishRoomState(session);
          break;
        case "presence":
          session.participantCount = message.participantCount;
          session.hostSessionId = message.hostSessionId;
          if (session.roomId) {
            session.connectionState =
              session.connectionState === "switching"
                ? "switching"
                : "connected";
          }
          publishRoomState(session);
          break;
        case "pong":
          break;
        case "error":
          if (
            message.code === "not_host" &&
            session.roomPlayback &&
            session.roomId
          ) {
            session.connectionState = "connected";
            session.lastError = "Only the host can control this room.";
            postToContent(session, {
              type: "background:apply-remote",
              roomId: session.roomId,
              participantCount: session.participantCount,
              hostSessionId: session.hostSessionId ?? "",
              playback: session.roomPlayback,
            });
          } else {
            session.connectionState = "error";
            session.lastError = message.message;
          }
          publishRoomState(session);
          break;
      }
    };

    const maybeAutoJoin = (session: TabSession) => {
      if (!session.localPlayback || !session.roomIdFromUrl) {
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

      if (
        session.connectionState === "connecting" ||
        session.connectionState === "switching"
      ) {
        return;
      }

      void connectSession(session, session.roomIdFromUrl);
    };

    const getLiveTabContext = async (
      session: TabSession,
      message: ContentOutboundMessage,
      port: Browser.runtime.Port,
    ) => {
      const liveTab = await browser.tabs
        .get(session.tabId)
        .catch(() => undefined);

      return {
        tabUrl:
          liveTab?.url ??
          port.sender?.tab?.url ??
          session.tabUrl ??
          message.tabUrl,
        tabTitle:
          liveTab?.title ??
          port.sender?.tab?.title ??
          session.tabTitle ??
          message.episode.episodeTitle,
      };
    };

    const handleContentSnapshot = async (
      session: TabSession,
      message: ContentOutboundMessage,
      port: Browser.runtime.Port,
    ) => {
      const previousPlayback = session.localPlayback;
      const liveTab = await getLiveTabContext(session, message, port);
      const normalizedPlayback = normalizePlaybackSnapshotForTab(
        message.playback,
        liveTab.tabUrl,
        liveTab.tabTitle,
      );

      session.activeFrameId = port.sender?.frameId ?? 0;
      session.tabUrl = liveTab.tabUrl ?? session.tabUrl ?? message.tabUrl;
      session.tabTitle = liveTab.tabTitle ?? session.tabTitle;
      session.localPlayback = normalizedPlayback;
      session.roomIdFromUrl = resolveRoomIdForTabContext(
        session.tabUrl,
        message.roomIdFromUrl ?? getRoomIdFromUrl(message.tabUrl),
      );

      if (
        session.autoJoinSuppressedRoomId &&
        session.roomIdFromUrl !== session.autoJoinSuppressedRoomId
      ) {
        session.autoJoinSuppressedRoomId = undefined;
      }

      await upsertWatchProgress(normalizedPlayback);

      if (
        session.connectionState === "switching" &&
        session.roomPlayback &&
        session.roomPlayback.episodeUrl === normalizedPlayback.episodeUrl
      ) {
        session.connectionState = "connected";
      }

      if (session.socket?.readyState === WebSocket.OPEN && session.roomId) {
        const nextUpdateType = shouldSendHostUpdate(
          session,
          previousPlayback,
          normalizedPlayback,
          message.reason,
        );

        if (nextUpdateType) {
          sendRoomUpdate(session, nextUpdateType, normalizedPlayback);
          session.connectionState = "connected";
          session.lastError = undefined;
        } else {
          handleFollowerCorrection(session, normalizedPlayback, message.reason);
        }
      } else if (!session.roomId) {
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
              backendHttpUrl: settings.backendHttpUrl,
              backendWsUrl: settings.backendWsUrl,
              recentRooms,
              themeMode: settings.themeMode,
              isHost: false,
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
          const currentPlayback =
            session?.roomPlayback ?? session?.localPlayback;

          return {
            activeTabId: activeTab.id,
            activeTabUrl: activeTab.url,
            supported,
            providerReady: Boolean(session?.localPlayback),
            connectionState: supported
              ? (session?.connectionState ?? "ready")
              : "unsupported",
            roomId: session?.roomId,
            shareUrl,
            participantCount: session?.participantCount ?? 0,
            episodeTitle: currentPlayback?.episodeTitle,
            backendHttpUrl: settings.backendHttpUrl,
            backendWsUrl: settings.backendWsUrl,
            recentRooms,
            watchProgress: await getWatchProgressForEpisode(
              currentPlayback?.episodeUrl,
            ),
            lastError: session?.lastError,
            hostSessionId: session?.hostSessionId,
            sessionId: session?.sessionId,
            isHost:
              Boolean(session?.sessionId) &&
              session?.hostSessionId === session?.sessionId,
            themeMode: settings.themeMode,
          };
        }
        case "popup:create-room": {
          const session = sessions.get(message.tabId);
          if (session?.localPlayback) {
            session.autoJoinSuppressedRoomId = undefined;
            await connectSession(session, session.roomId);
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
        backendHttpUrl: settings.backendHttpUrl,
        backendWsUrl: settings.backendWsUrl,
        recentRooms,
        themeMode: settings.themeMode,
        lastError: "Unable to read extension state.",
        isHost: false,
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

    browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local" || !changes.settings) {
        return;
      }

      const previousSettings = changes.settings.oldValue as
        | ExtensionSettings
        | undefined;
      const nextSettings = changes.settings.newValue as
        | ExtensionSettings
        | undefined;
      const backendChanged =
        previousSettings?.backendWsUrl !== nextSettings?.backendWsUrl ||
        previousSettings?.backendHttpUrl !== nextSettings?.backendHttpUrl;
      if (!backendChanged) {
        return;
      }

      for (const session of sessions.values()) {
        if (
          !session.roomId ||
          !session.localPlayback ||
          !getActivePort(session)
        ) {
          continue;
        }

        void connectSession(session, session.roomId);
      }
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
              if (!isIgnorablePortError(error)) {
                console.error("Failed to respond to popup port", error);
              }
            }
          });
        });
        return;
      }

      if (port.name !== CONTENT_PORT_NAME) {
        return;
      }

      const tabId = port.sender?.tab?.id;
      const frameId = port.sender?.frameId ?? 0;

      if (!tabId) {
        return;
      }

      const session = getOrCreateSession(tabId);
      session.ports.set(frameId, port);
      session.connectionState =
        session.roomId && session.connectionState !== "switching"
          ? "connected"
          : session.connectionState === "switching"
            ? "switching"
            : "ready";

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

        session.cleanupTimeout = setTimeout(
          () => {
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
          },
          session.roomId
            ? NAVIGATION_CLEANUP_TIMEOUT_MS
            : DISCONNECTED_CLEANUP_TIMEOUT_MS,
        );
      });
    });

    browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      const session = sessions.get(tabId);
      if (!session) {
        return;
      }

      if (typeof changeInfo.url === "string") {
        session.tabUrl = changeInfo.url;
        session.roomIdFromUrl = resolveRoomIdForTabContext(
          changeInfo.url,
          session.roomIdFromUrl,
        );
        if (session.roomId) {
          session.connectionState = "switching";
          session.lastError = undefined;
          publishRoomState(session);
        }
      }

      if (typeof tab.title === "string" && tab.title.trim().length > 0) {
        session.tabTitle = tab.title;
      }
    });

    browser.tabs.onRemoved.addListener((tabId) => {
      const session = sessions.get(tabId);
      if (!session) {
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

  if (
    session.connectionState === "connecting" ||
    session.connectionState === "switching"
  ) {
    return "...";
  }

  if (session.connectionState === "error") {
    return "!";
  }

  if (session.localPlayback) {
    return "ON";
  }

  return "";
}

function getActionBadgeColor(session: TabSession): string {
  if (session.connectionState === "connected") {
    return "#f97316";
  }

  if (
    session.connectionState === "connecting" ||
    session.connectionState === "switching"
  ) {
    return "#f59e0b";
  }

  if (session.connectionState === "error") {
    return "#ef4444";
  }

  return "#22c55e";
}

function getActionTitle(session: TabSession): string {
  if (session.connectionState === "connected" && session.roomId) {
    const role =
      session.sessionId && session.hostSessionId === session.sessionId
        ? "host"
        : "viewer";
    return `Roll Together: ${role} in ${session.roomId.slice(0, 8)} with ${session.participantCount} viewer${session.participantCount === 1 ? "" : "s"}`;
  }

  if (session.connectionState === "switching") {
    return "Roll Together: Switching episode";
  }

  if (session.connectionState === "connecting") {
    return "Roll Together: Connecting to room";
  }

  if (session.connectionState === "error") {
    return `Roll Together: ${session.lastError ?? "Connection issue"}`;
  }

  if (session.localPlayback?.episodeTitle) {
    return `Roll Together: Player detected for ${session.localPlayback.episodeTitle}`;
  }

  return DEFAULT_ACTION_TITLE;
}
