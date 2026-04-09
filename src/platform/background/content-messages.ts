import type { Browser } from "wxt/browser";

import type {
  ContentOutboundMessage,
  ContentSnapshotReason,
} from "../../core/messages";
import type { PlaybackSnapshot } from "../../core/protocol";
import { needsPlaybackCorrection } from "../../core/reconcile";
import { upsertWatchProgress } from "../../core/storage";
import { getRoomIdFromUrl } from "../../core/url";
import {
  normalizePlaybackSnapshotForTab,
  resolveRoomIdForTabContext,
} from "../../providers/crunchyroll/session";

import type { TabSession } from "./session-state";

const WATCH_PROGRESS_WRITE_INTERVAL_MS = 15_000;
const HEARTBEAT_CORRECTION_THRESHOLD_SECONDS = 3;
const HEARTBEAT_STATE_REQUEST_COOLDOWN_MS = 6_000;

function mapReasonToPlaybackCommand(reason: ContentSnapshotReason) {
  if (reason === "play") {
    return "play" as const;
  }

  if (reason === "pause") {
    return "pause" as const;
  }

  if (reason === "seeked") {
    return "seek" as const;
  }

  return undefined;
}

interface ContentMessageControllerOptions {
  connectSession: (
    session: TabSession,
    requestedRoomId?: string,
  ) => Promise<void>;
  sendPlaybackCommand: (
    session: TabSession,
    command: "play" | "pause" | "seek",
    playback: PlaybackSnapshot,
  ) => void;
  requestRoomState: (session: TabSession) => void;
  publishRoomState: (session: TabSession) => void;
}

function shouldPersistWatchProgress(
  session: TabSession,
  previousPlayback: PlaybackSnapshot | undefined,
  nextPlayback: PlaybackSnapshot,
  reason:
    | "initial"
    | "play"
    | "pause"
    | "seeked"
    | "discontinuity"
    | "heartbeat"
    | "remote-apply",
) {
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
    Date.now() - session.lastWatchProgressAt >= WATCH_PROGRESS_WRITE_INTERVAL_MS
  );
}

export function createContentMessageController({
  connectSession,
  sendPlaybackCommand,
  requestRoomState,
  publishRoomState,
}: ContentMessageControllerOptions) {
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

    if (session.connectionState === "connecting") {
      return;
    }

    void connectSession(session, session.roomIdFromUrl);
  };

  const requestCanonicalStateWithCooldown = (session: TabSession) => {
    const now = Date.now();
    if (
      session.lastStateRequestAt &&
      now - session.lastStateRequestAt < HEARTBEAT_STATE_REQUEST_COOLDOWN_MS
    ) {
      return;
    }

    session.lastStateRequestAt = now;
    requestRoomState(session);
  };

  const handleCommandResult = (
    session: TabSession,
    message: Extract<
      ContentOutboundMessage,
      { type: "content:command-result" }
    >,
  ) => {
    if (session.latestDeliveredCommandId !== message.commandId) {
      return;
    }

    session.latestCommandStatus = message.status;
    session.latestCommandMessage = message.message;
    if (message.status === "applied") {
      session.latestAppliedRevision = message.revision;
      if (message.snapshot) {
        session.localPlayback = message.snapshot;
      }
      if (session.lastError && session.lastError.includes("command")) {
        session.lastError = undefined;
      }
    } else if (message.status === "failed" || message.status === "timed_out") {
      session.lastError = message.message ?? "Remote playback apply failed.";
    }
  };

  const handleContentSnapshot = (
    session: TabSession,
    message: Extract<ContentOutboundMessage, { type: "content:snapshot" }>,
    port: Browser.runtime.Port,
  ) => {
    const previousPlayback = session.localPlayback;
    const tabUrl = session.tabUrl ?? port.sender?.tab?.url ?? message.tabUrl;
    const tabTitle =
      session.tabTitle ??
      port.sender?.tab?.title ??
      message.episode.episodeTitle;

    const normalizedPlayback = normalizePlaybackSnapshotForTab(
      message.playback,
      tabUrl,
      tabTitle,
    );

    session.activeFrameId = port.sender?.frameId ?? 0;
    session.tabUrl = tabUrl ?? session.tabUrl ?? message.tabUrl;
    session.tabTitle = tabTitle ?? session.tabTitle;
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

    if (
      shouldPersistWatchProgress(
        session,
        previousPlayback,
        normalizedPlayback,
        message.reason,
      )
    ) {
      session.lastWatchProgressAt = Date.now();
      void upsertWatchProgress(normalizedPlayback).catch((error) => {
        console.error("Failed to persist watch progress", error);
      });
    }

    if (session.connectionState === "connected" && session.roomId) {
      const mappedCommand = mapReasonToPlaybackCommand(message.reason);
      const roomEpisodeId = session.roomPlayback?.episodeId;

      if (
        session.episodeMismatch &&
        roomEpisodeId &&
        normalizedPlayback.episodeId === roomEpisodeId
      ) {
        session.episodeMismatch = undefined;
        session.lastError = undefined;
        requestCanonicalStateWithCooldown(session);
      }

      if (
        mappedCommand &&
        (!roomEpisodeId || normalizedPlayback.episodeId === roomEpisodeId)
      ) {
        sendPlaybackCommand(session, mappedCommand, normalizedPlayback);
        session.lastError = undefined;
      } else if (
        message.reason === "heartbeat" &&
        roomEpisodeId &&
        normalizedPlayback.episodeId === roomEpisodeId &&
        needsPlaybackCorrection(
          normalizedPlayback,
          session.roomPlayback,
          HEARTBEAT_CORRECTION_THRESHOLD_SECONDS,
        )
      ) {
        requestCanonicalStateWithCooldown(session);
      }
    } else if (!session.roomId) {
      session.connectionState = "ready";
    }

    maybeAutoJoin(session);
    publishRoomState(session);
  };

  const handleContentMessage = (
    session: TabSession,
    message: ContentOutboundMessage,
    port: Browser.runtime.Port,
  ) => {
    if (message.type === "content:command-result") {
      handleCommandResult(session, message);
      publishRoomState(session);
      return;
    }

    if (message.type === "content:snapshot") {
      handleContentSnapshot(session, message, port);
    }
  };

  return {
    handleContentMessage,
  };
}
