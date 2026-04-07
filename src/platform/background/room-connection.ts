import { browser } from "wxt/browser";

import type { ApplyRemotePlaybackMessage } from "../../core/messages";
import {
  PROTOCOL_VERSION,
  parseServerMessage,
  type JoinMessage,
  type PingMessage,
  type PlaybackSnapshot,
  type ServerMessage,
} from "../../core/protocol";
import { getSettings, upsertRecentRoom } from "../../core/storage";
import {
  needsPlaybackCorrection,
  shouldAcceptRoomPlaybackUpdate,
} from "../../core/reconcile";
import { buildRoomInviteUrl } from "../../core/url";

import { getActivePort, type TabSession } from "./session-state";
import { isIgnorableTabLifecycleError } from "./runtime-errors";

const RECONNECT_DELAYS_MS = [250, 750, 1_500, 3_000];
const SOCKET_PING_INTERVAL_MS = 20_000;

interface RoomConnectionControllerOptions {
  publishRoomState: (session: TabSession) => void;
  queuePopupStatePublish: () => void;
  postToContent: (
    session: TabSession,
    message: ApplyRemotePlaybackMessage,
  ) => void;
}

interface SocketWithReconnectFlag extends WebSocket {
  __rtSuppressReconnect?: boolean;
}

export function createRoomConnectionController({
  publishRoomState,
  queuePopupStatePublish,
  postToContent,
}: RoomConnectionControllerOptions) {
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

    const socket = session.socket as SocketWithReconnectFlag | undefined;
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
      session.participants = [];
    }

    if (options.clearIdentity) {
      session.sessionId = undefined;
    }
  };

  const applyRoomPlaybackIfNeeded = (
    session: TabSession,
    playback: PlaybackSnapshot,
    roomId: string,
    participantCount: number,
    hostSessionId: string,
  ) => {
    if (!needsPlaybackCorrection(session.localPlayback, playback)) {
      return;
    }

    postToContent(session, {
      type: "background:apply-remote",
      roomId,
      participantCount,
      hostSessionId,
      playback,
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

    const payload = {
      type,
      version: PROTOCOL_VERSION,
      playback,
    };

    session.socket.send(JSON.stringify(payload));
    session.roomPlayback = playback;
    session.lastOutboundPlayback = playback;
    session.lastOutboundAt = Date.now();
  };

  const scheduleReconnect = (session: TabSession, roomId: string) => {
    stopReconnect(session);
    const delayMs =
      RECONNECT_DELAYS_MS[
        Math.min(session.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
      ];
    session.reconnectAttempt += 1;
    session.reconnectTimeout = setTimeout(() => {
      if (!getActivePort(session) || !session.localPlayback) {
        return;
      }
      void connectSession(session, roomId);
    }, delayMs);
  };

  const handleServerMessage = (session: TabSession, message: ServerMessage) => {
    switch (message.type) {
      case "joined": {
        session.connectionState = "connected";
        session.roomId = message.roomId;
        session.sessionId = message.sessionId;
        session.hostSessionId = message.hostSessionId;
        session.participantCount = message.participantCount;
        session.participants = message.participants;
        session.lastError = undefined;
        session.roomPlayback = message.playback;

        const shareUrl =
          session.tabUrl && session.roomId
            ? buildRoomInviteUrl(session.tabUrl, session.roomId)
            : undefined;

        if (shareUrl) {
          void upsertRecentRoom({
            roomId: session.roomId,
            shareUrl,
            episodeTitle: message.playback.episodeTitle,
            episodeUrl: message.playback.episodeUrl,
            updatedAt: Date.now(),
          })
            .then(() => {
              queuePopupStatePublish();
            })
            .catch((error) => {
              console.error("Failed to save recent room", error);
            });
        }

        applyRoomPlaybackIfNeeded(
          session,
          message.playback,
          message.roomId,
          message.participantCount,
          message.hostSessionId,
        );

        publishRoomState(session);
        break;
      }
      case "sync": {
        session.connectionState = "connected";
        session.roomId = message.roomId;
        session.participantCount = message.participantCount;
        session.participants = message.participants;
        session.hostSessionId = message.hostSessionId;
        session.lastError = undefined;

        if (
          shouldAcceptRoomPlaybackUpdate(session.roomPlayback, message.playback)
        ) {
          session.roomPlayback = message.playback;
          applyRoomPlaybackIfNeeded(
            session,
            message.playback,
            message.roomId,
            message.participantCount,
            message.hostSessionId,
          );
        }

        publishRoomState(session);
        break;
      }
      case "navigate": {
        session.roomId = message.roomId;
        session.participantCount = message.participantCount;
        session.participants = message.participants;
        session.hostSessionId = message.hostSessionId;
        session.lastError = undefined;

        if (
          !shouldAcceptRoomPlaybackUpdate(
            session.roomPlayback,
            message.playback,
          )
        ) {
          if (session.roomId) {
            session.connectionState =
              session.connectionState === "switching"
                ? "switching"
                : "connected";
          }
          publishRoomState(session);
          break;
        }

        session.roomPlayback = message.playback;

        void upsertRecentRoom({
          roomId: message.roomId,
          shareUrl: buildRoomInviteUrl(
            message.playback.episodeUrl,
            message.roomId,
          ),
          episodeTitle: message.playback.episodeTitle,
          episodeUrl: message.playback.episodeUrl,
          updatedAt: Date.now(),
        })
          .then(() => {
            queuePopupStatePublish();
          })
          .catch((error) => {
            console.error("Failed to save navigated room", error);
          });

        if (session.localPlayback?.episodeUrl === message.playback.episodeUrl) {
          session.connectionState = "connected";
          applyRoomPlaybackIfNeeded(
            session,
            message.playback,
            message.roomId,
            message.participantCount,
            message.hostSessionId,
          );
        } else {
          navigateTabToPlayback(session, message.playback, message.roomId);
        }
        publishRoomState(session);
        break;
      }
      case "presence":
        session.participantCount = message.participantCount;
        session.participants = message.participants;
        session.hostSessionId = message.hostSessionId;
        if (session.roomId) {
          session.connectionState =
            session.connectionState === "switching" ? "switching" : "connected";
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

    const socket = new WebSocket(
      settings.backendWsUrl,
    ) as SocketWithReconnectFlag;
    session.socket = socket;

    socket.addEventListener("open", () => {
      if (session.socket !== socket || !session.localPlayback) {
        return;
      }

      session.reconnectAttempt = 0;

      const joinMessage: JoinMessage = {
        type: "join",
        version: PROTOCOL_VERSION,
        roomId: requestedRoomId,
        sessionId: session.sessionId,
        displayName: settings.displayName,
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
      }, SOCKET_PING_INTERVAL_MS);
    });

    socket.addEventListener("message", (event) => {
      if (session.socket !== socket || typeof event.data !== "string") {
        return;
      }

      const message = parseServerMessage(event.data);
      if (!message) {
        return;
      }

      handleServerMessage(session, message);
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

  return {
    closeSocket,
    connectSession,
    sendRoomUpdate,
  };
}
