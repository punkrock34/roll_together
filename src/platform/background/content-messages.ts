import type { Browser } from "wxt/browser";

import type {
  ApplyRemotePlaybackMessage,
  ContentOutboundMessage,
} from "../../core/messages";
import type { PlaybackSnapshot } from "../../core/protocol";
import {
  arePlaybackSnapshotsSimilar,
  buildSyncDecision,
} from "../../core/reconcile";
import { upsertWatchProgress } from "../../core/storage";
import { getRoomIdFromUrl } from "../../core/url";
import {
  didEpisodeChange,
  normalizePlaybackSnapshotForTab,
  resolveRoomIdForTabContext,
} from "../../providers/crunchyroll/session";

import type { TabSession } from "./session-state";

const HOST_HEARTBEAT_INTERVAL_MS = 4_000;
const WATCH_PROGRESS_WRITE_INTERVAL_MS = 15_000;

interface ContentMessageControllerOptions {
  connectSession: (
    session: TabSession,
    requestedRoomId?: string,
  ) => Promise<void>;
  sendRoomUpdate: (
    session: TabSession,
    type: "sync" | "navigate",
    playback: PlaybackSnapshot,
  ) => void;
  postToContent: (
    session: TabSession,
    message: ApplyRemotePlaybackMessage,
  ) => void;
  publishRoomState: (session: TabSession) => void;
}

export function createContentMessageController({
  connectSession,
  sendRoomUpdate,
  postToContent,
  publishRoomState,
}: ContentMessageControllerOptions) {
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
          1,
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
        0.15,
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

  const resolveTabContext = (
    session: TabSession,
    message: ContentOutboundMessage,
    port: Browser.runtime.Port,
  ) => ({
    tabUrl: session.tabUrl ?? port.sender?.tab?.url ?? message.tabUrl,
    tabTitle:
      session.tabTitle ??
      port.sender?.tab?.title ??
      message.episode.episodeTitle,
  });

  const shouldPersistWatchProgress = (
    session: TabSession,
    previousPlayback: PlaybackSnapshot | undefined,
    nextPlayback: PlaybackSnapshot,
    reason: ContentOutboundMessage["reason"],
  ) => {
    if (reason !== "heartbeat") {
      return true;
    }

    if (nextPlayback.state !== "playing") {
      return true;
    }

    if (previousPlayback?.episodeUrl !== nextPlayback.episodeUrl) {
      return true;
    }

    return (
      !session.lastWatchProgressAt ||
      Date.now() - session.lastWatchProgressAt >=
        WATCH_PROGRESS_WRITE_INTERVAL_MS
    );
  };

  const queueWatchProgressUpdate = (
    session: TabSession,
    playback: PlaybackSnapshot,
    previousPlayback: PlaybackSnapshot | undefined,
    reason: ContentOutboundMessage["reason"],
  ) => {
    if (
      !shouldPersistWatchProgress(session, previousPlayback, playback, reason)
    ) {
      return;
    }

    session.lastWatchProgressAt = Date.now();
    void upsertWatchProgress(playback).catch((error) => {
      console.error("Failed to persist watch progress", error);
    });
  };

  const handleContentSnapshot = (
    session: TabSession,
    message: ContentOutboundMessage,
    port: Browser.runtime.Port,
  ) => {
    const previousPlayback = session.localPlayback;
    const liveTab = resolveTabContext(session, message, port);
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

    queueWatchProgressUpdate(
      session,
      normalizedPlayback,
      previousPlayback,
      message.reason,
    );

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

  return {
    handleContentSnapshot,
  };
}
