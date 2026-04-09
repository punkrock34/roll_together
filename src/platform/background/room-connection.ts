import { io, type Socket } from "socket.io-client";
import { browser } from "wxt/browser";

import type {
  ApplyRemotePlaybackMessage,
  BackgroundOutboundMessage,
  ContentPlayerStateMessage,
  PlayerRuntimeState,
} from "../../core/messages";
import {
  PROTOCOL_VERSION,
  parseCommandErrorPayload,
  parseHeartbeatAckPayload,
  parsePresenceUpdatePayload,
  parseRoomNavigationPayload,
  parseRoomJoinedPayload,
  parseStateSnapshotPayload,
  resolveRoomCapabilities,
  type PlaybackSnapshot,
  type RoomNavigationPayload,
  type RoomStateSnapshot,
} from "../../core/protocol";
import { getSettings, upsertRecentRoom } from "../../core/storage";
import {
  buildSyncDecision,
  needsPlaybackCorrection,
} from "../../core/reconcile";
import { buildRoomInviteUrl } from "../../core/url";

import { getActivePort, type TabSession } from "./session-state";

const RECONNECT_DELAYS_MS = [250, 750, 1_500, 3_000];
const SOCKET_HEARTBEAT_INTERVAL_MS = 20_000;
const DEFAULT_DRIFT_THRESHOLD_SECONDS = 3;
const SAME_REVISION_REAPPLY_COOLDOWN_MS = 1_500;
const COMMAND_VERIFICATION_TIMEOUT_MS = 4_000;
const COMMAND_VERIFICATION_POLL_INTERVAL_MS = 120;
const COMMAND_TIME_TOLERANCE_SECONDS = 1.2;
const MIN_PLAY_PROGRESS_SECONDS = 0.15;
const WATCHDOG_POLL_INTERVAL_MS = 1_200;
const WATCHDOG_PENDING_TIMEOUT_MS = 2_000;
const WATCHDOG_DRIFT_THRESHOLD_SECONDS = 2.4;
const WATCHDOG_STATE_REQUEST_COOLDOWN_MS = 1_500;
const ENABLE_SYNC_DEBUG_LOGS = import.meta.env.WXT_PUBLIC_SYNC_DEBUG === "1";
const IMPORTANT_SYNC_EVENTS = new Set([
  "playback_command_emit",
  "playback_command_applied",
  "playback_command_failed",
  "room_navigation_emit",
  "room_navigation_follow",
  "room_navigation_failed",
  "room_navigation_applied",
  "host_transfer_emit",
  "room_control_mode_emit",
  "command_error",
]);

export interface CommandVerificationProgress {
  playBaselineAt?: number;
  playBaselineTime?: number;
}

export interface CommandVerificationContext {
  targetState: "playing" | "paused";
  expectedTime: number;
  requiresSeek: boolean;
}

function resolveExpectedPlaybackTime(
  snapshot: PlaybackSnapshot,
  now = Date.now(),
) {
  if (snapshot.state !== "playing") {
    return snapshot.currentTime;
  }

  const elapsedSeconds = Math.max(0, (now - snapshot.updatedAt) / 1_000);
  const projected =
    snapshot.currentTime + elapsedSeconds * snapshot.playbackRate;

  if (snapshot.duration === null) {
    return projected;
  }

  return Math.min(projected, snapshot.duration);
}

export function evaluatePlayerStateConvergence(
  context: CommandVerificationContext,
  playerState: PlayerRuntimeState,
  progress: CommandVerificationProgress,
  now = Date.now(),
) {
  const timeMatches =
    Math.abs(playerState.currentTime - context.expectedTime) <=
    COMMAND_TIME_TOLERANCE_SECONDS;

  if (context.targetState === "paused") {
    return {
      converged: playerState.paused && !playerState.seeking && timeMatches,
      progress: {} satisfies CommandVerificationProgress,
    };
  }

  const canPlay =
    !playerState.paused &&
    playerState.readyState >= 2 &&
    !playerState.ended &&
    !playerState.seeking;

  if (!canPlay) {
    return {
      converged: false,
      progress: {} satisfies CommandVerificationProgress,
    };
  }

  if (context.requiresSeek && !timeMatches) {
    return {
      converged: false,
      progress,
    };
  }

  const nextProgress: CommandVerificationProgress = { ...progress };
  if (
    nextProgress.playBaselineAt === undefined ||
    nextProgress.playBaselineTime === undefined
  ) {
    nextProgress.playBaselineAt = now;
    nextProgress.playBaselineTime = playerState.currentTime;
    return {
      converged: false,
      progress: nextProgress,
    };
  }

  const progressed =
    playerState.currentTime - nextProgress.playBaselineTime >=
    MIN_PLAY_PROGRESS_SECONDS;

  return {
    converged: progressed,
    progress: nextProgress,
  };
}

export function shouldApplyRoomRevision(
  currentRevision: number | undefined,
  incomingRevision: number,
) {
  if (currentRevision === undefined) {
    return true;
  }
  return incomingRevision > currentRevision;
}

interface RoomConnectionControllerOptions {
  publishRoomState: (session: TabSession) => void;
  queuePopupStatePublish: () => void;
  postToContent: (
    session: TabSession,
    message: BackgroundOutboundMessage,
  ) => boolean;
}

interface SocketWithReconnectFlag extends Socket {
  __rtSuppressReconnect?: boolean;
}

function resolveSocketEndpoint(backendWsUrl: string) {
  const parsed = new URL(backendWsUrl);
  const protocol =
    parsed.protocol === "wss:"
      ? "https:"
      : parsed.protocol === "ws:"
        ? "http:"
        : parsed.protocol;

  return {
    baseUrl: `${protocol}//${parsed.host}`,
    path: parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "/ws",
  };
}

export function createRoomConnectionController({
  publishRoomState,
  queuePopupStatePublish,
  postToContent,
}: RoomConnectionControllerOptions) {
  const logSync = (event: string, details?: Record<string, unknown>) => {
    if (!ENABLE_SYNC_DEBUG_LOGS || !IMPORTANT_SYNC_EVENTS.has(event)) {
      return;
    }

    console.log("[rt-sync-bg]", {
      event,
      ...(details ?? {}),
    });
  };

  const clearCapabilities = (session: TabSession) => {
    session.canControlPlayback = false;
    session.canNavigateEpisodes = false;
    session.canTransferHost = false;
  };

  const refreshCapabilities = (session: TabSession) => {
    if (!session.sessionId || !session.hostSessionId || !session.controlMode) {
      clearCapabilities(session);
      return;
    }

    const capabilities = resolveRoomCapabilities({
      controlMode: session.controlMode,
      hostSessionId: session.hostSessionId,
      sessionId: session.sessionId,
    });
    session.canControlPlayback = capabilities.canControlPlayback;
    session.canNavigateEpisodes = capabilities.canNavigate;
    session.canTransferHost = capabilities.canTransferHost;
  };

  const applyAuthorityFromRoomState = (
    session: TabSession,
    state: RoomStateSnapshot,
  ) => {
    session.hostSessionId = state.hostSessionId;
    session.controlMode = state.controlMode;
    session.navigationRevision = state.navigationRevision;
    refreshCapabilities(session);
  };

  const requestCanonicalState = (session: TabSession) => {
    if (!session.socket || !session.socket.connected) {
      return;
    }

    session.socket.emit("request_state", {
      version: PROTOCOL_VERSION,
    });
  };

  const stopHeartbeat = (session: TabSession) => {
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

  const stopWatchdog = (session: TabSession) => {
    if (session.watchdogInterval) {
      clearInterval(session.watchdogInterval);
      session.watchdogInterval = undefined;
    }
    session.watchdogPending = undefined;
  };

  const clearVerificationTransaction = (session: TabSession) => {
    const tx = session.verificationTransaction;
    if (tx?.pollInterval) {
      clearInterval(tx.pollInterval);
    }
    session.verificationTransaction = undefined;
  };

  const finalizeVerification = (
    session: TabSession,
    status: "applied" | "failed" | "timed_out",
    message?: string,
    snapshot?: PlaybackSnapshot,
  ) => {
    const tx = session.verificationTransaction;
    if (!tx) {
      return;
    }

    clearVerificationTransaction(session);
    session.latestDeliveredCommandId = tx.commandId;
    session.latestCommandStatus = status;
    session.latestCommandMessage = message;

    if (snapshot) {
      session.localPlayback = snapshot;
    }

    if (status === "applied") {
      session.latestAppliedRevision = tx.revision;
      if (session.lastError && session.lastError.includes("sync")) {
        session.lastError = undefined;
      }
    } else {
      session.lastError = message ?? "Playback verification failed.";
      if (status === "timed_out") {
        requestCanonicalState(session);
      }
    }

    logSync("verification finalized", {
      tabId: session.tabId,
      roomId: tx.roomId,
      revision: tx.revision,
      status,
      message,
    });

    publishRoomState(session);
  };

  const pollVerificationState = (session: TabSession) => {
    const tx = session.verificationTransaction;
    if (!tx) {
      return;
    }

    if (Date.now() >= tx.deadlineAt) {
      finalizeVerification(
        session,
        "timed_out",
        "Timed out waiting for player convergence.",
      );
      return;
    }

    const delivered = postToContent(session, {
      type: "background:query-player-state",
      commandId: tx.commandId,
      roomId: tx.roomId,
      revision: tx.revision,
    });

    if (!delivered) {
      finalizeVerification(
        session,
        "failed",
        "Failed to query current player state from content script.",
      );
    }
  };

  const startVerification = (
    session: TabSession,
    message: ApplyRemotePlaybackMessage,
    context: {
      requiresSeek: boolean;
    },
  ) => {
    clearVerificationTransaction(session);
    session.verificationTransaction = {
      commandId: message.commandId,
      roomId: message.roomId,
      revision: message.revision,
      targetPlayback: message.playback,
      targetState: message.playback.state,
      requiresSeek: context.requiresSeek,
      deadlineAt: Date.now() + COMMAND_VERIFICATION_TIMEOUT_MS,
    };

    pollVerificationState(session);

    const tx = session.verificationTransaction;
    if (!tx) {
      return;
    }
    tx.pollInterval = setInterval(() => {
      pollVerificationState(session);
    }, COMMAND_VERIFICATION_POLL_INTERVAL_MS);
  };

  const triggerWatchdogProbe = (session: TabSession) => {
    if (
      !session.roomId ||
      session.roomRevision === undefined ||
      !session.socket ||
      !session.socket.connected ||
      !getActivePort(session)
    ) {
      return;
    }

    const stalePending =
      session.watchdogPending &&
      Date.now() - session.watchdogPending.issuedAt >
        WATCHDOG_PENDING_TIMEOUT_MS;
    if (stalePending) {
      session.watchdogPending = undefined;
    }

    if (
      session.watchdogPending ||
      session.verificationTransaction ||
      !session.roomPlayback ||
      !session.localPlayback ||
      session.episodeMismatch
    ) {
      return;
    }

    const commandId = `watchdog:${session.roomId}:${session.roomRevision}:${Date.now()}`;
    const delivered = postToContent(session, {
      type: "background:query-player-state",
      commandId,
      roomId: session.roomId,
      revision: session.roomRevision,
    });

    if (!delivered) {
      return;
    }

    session.watchdogPending = {
      commandId,
      roomId: session.roomId,
      revision: session.roomRevision,
      issuedAt: Date.now(),
    };
  };

  const startWatchdog = (session: TabSession) => {
    stopWatchdog(session);
    session.watchdogInterval = setInterval(() => {
      triggerWatchdogProbe(session);
    }, WATCHDOG_POLL_INTERVAL_MS);
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
    stopHeartbeat(session);
    stopReconnect(session);
    stopWatchdog(session);
    clearVerificationTransaction(session);

    const socket = session.socket as SocketWithReconnectFlag | undefined;
    session.socket = undefined;

    if (socket) {
      socket.__rtSuppressReconnect = options.suppressReconnect;
      if (options.sendLeave && socket.connected) {
        socket.emit("leave_room", {
          version: PROTOCOL_VERSION,
        });
      }
      socket.disconnect();
    }

    if (options.clearRoom) {
      session.roomId = undefined;
      session.roomPlayback = undefined;
      session.roomState = undefined;
      session.roomRevision = undefined;
      session.navigationRevision = undefined;
      session.hostSessionId = undefined;
      session.controlMode = undefined;
      session.latestAppliedRevision = undefined;
      session.latestDeliveredCommandId = undefined;
      session.latestCommandStatus = undefined;
      session.latestCommandMessage = undefined;
      session.participantCount = 1;
      session.participants = [];
      session.episodeMismatch = undefined;
      session.pendingRemoteNavigation = undefined;
      clearCapabilities(session);
    }

    if (options.clearIdentity) {
      session.sessionId = undefined;
      clearCapabilities(session);
    }
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

  const followRoomNavigation = (
    session: TabSession,
    navigation: Pick<
      RoomNavigationPayload,
      | "roomId"
      | "revision"
      | "navigationRevision"
      | "initiatedBySessionId"
      | "playback"
    >,
  ) => {
    if (!session.roomId || navigation.roomId !== session.roomId) {
      return;
    }

    if (
      session.sessionId &&
      navigation.initiatedBySessionId === session.sessionId
    ) {
      session.pendingRemoteNavigation = undefined;
      session.connectionState = "connected";
      session.lastError = undefined;
      return;
    }

    if (session.localPlayback?.episodeId === navigation.playback.episodeId) {
      session.pendingRemoteNavigation = undefined;
      session.connectionState = "connected";
      session.episodeMismatch = undefined;
      session.lastError = undefined;
      requestCanonicalState(session);
      return;
    }

    const existing = session.pendingRemoteNavigation;
    if (
      existing &&
      existing.episodeId === navigation.playback.episodeId &&
      existing.navigationRevision >= navigation.navigationRevision
    ) {
      return;
    }

    const targetUrl = buildRoomInviteUrl(
      navigation.playback.episodeUrl,
      navigation.roomId,
    );
    session.pendingRemoteNavigation = {
      navigationRevision: navigation.navigationRevision,
      episodeId: navigation.playback.episodeId,
      targetUrl,
      initiatedBySessionId: navigation.initiatedBySessionId,
      issuedAt: Date.now(),
    };
    session.connectionState = "switching";
    session.episodeMismatch = {
      localEpisodeId: session.localPlayback?.episodeId,
      roomEpisodeId: navigation.playback.episodeId,
    };
    session.lastError = undefined;
    publishRoomState(session);

    void browser.tabs
      .update(session.tabId, { url: targetUrl })
      .then(() => {
        logSync("room_navigation_follow", {
          tabId: session.tabId,
          roomId: navigation.roomId,
          revision: navigation.revision,
          navigationRevision: navigation.navigationRevision,
          episodeId: navigation.playback.episodeId,
          initiatedBySessionId: navigation.initiatedBySessionId,
        });
      })
      .catch(() => {
        session.lastError = "Failed to follow room episode navigation.";
        publishRoomState(session);
        logSync("room_navigation_failed", {
          tabId: session.tabId,
          roomId: navigation.roomId,
          navigationRevision: navigation.navigationRevision,
          episodeId: navigation.playback.episodeId,
        });
      });
  };

  const deliverRoomSnapshotToContent = (
    session: TabSession,
    state: RoomStateSnapshot,
  ) => {
    if (!session.localPlayback || !session.roomId) {
      return;
    }

    if (session.localPlayback.episodeId !== state.playback.episodeId) {
      followRoomNavigation(session, {
        roomId: state.roomId,
        revision: state.revision,
        navigationRevision: state.navigationRevision,
        initiatedBySessionId: state.hostSessionId,
        playback: state.playback,
      });
      return;
    }

    if (session.verificationTransaction?.revision === state.revision) {
      return;
    }

    session.episodeMismatch = undefined;
    const decision = buildSyncDecision(
      session.localPlayback,
      state.playback,
      DEFAULT_DRIFT_THRESHOLD_SECONDS,
    );

    if (!decision.shouldPause && !decision.shouldPlay && !decision.shouldSeek) {
      return;
    }

    const commandId = `${state.roomId}:${state.revision}:${Date.now()}`;
    const applyMessage: ApplyRemotePlaybackMessage = {
      type: "background:apply-state-snapshot",
      commandId,
      roomId: state.roomId,
      revision: state.revision,
      state,
      playback: state.playback,
      driftThresholdSeconds: DEFAULT_DRIFT_THRESHOLD_SECONDS,
    };
    const delivered = postToContent(session, applyMessage);

    session.latestDeliveredCommandId = commandId;
    session.latestCommandStatus = delivered ? "delivered" : "failed";
    session.latestCommandMessage = delivered
      ? undefined
      : "Failed to deliver playback command to content script.";
    if (!delivered) {
      session.lastError = session.latestCommandMessage;
      logSync("playback_command_failed", {
        tabId: session.tabId,
        roomId: state.roomId,
        revision: state.revision,
      });
      return;
    }

    logSync("playback_command_applied", {
      tabId: session.tabId,
      roomId: state.roomId,
      revision: state.revision,
      targetState: state.playback.state,
      targetTime: state.playback.currentTime,
    });

    startVerification(session, applyMessage, {
      requiresSeek: decision.shouldSeek,
    });
  };

  const applyIncomingRoomState = (
    session: TabSession,
    state: RoomStateSnapshot,
    options?: {
      allowSameRevisionReapply?: boolean;
    },
  ) => {
    const isNewerRevision = shouldApplyRoomRevision(
      session.roomRevision,
      state.revision,
    );

    if (!isNewerRevision) {
      if (session.verificationTransaction?.revision === state.revision) {
        return;
      }

      if (!options?.allowSameRevisionReapply) {
        return;
      }

      if (session.roomRevision !== state.revision) {
        return;
      }

      if (
        !needsPlaybackCorrection(
          session.localPlayback,
          state.playback,
          DEFAULT_DRIFT_THRESHOLD_SECONDS,
        )
      ) {
        return;
      }

      const now = Date.now();
      if (
        session.lastSameRevisionReapplyAt &&
        now - session.lastSameRevisionReapplyAt <
          SAME_REVISION_REAPPLY_COOLDOWN_MS
      ) {
        return;
      }
      session.lastSameRevisionReapplyAt = now;

      session.connectionState = "connected";
      session.roomId = state.roomId;
      session.roomState = state;
      session.roomPlayback = state.playback;
      session.participantCount = state.participantCount;
      session.participants = state.participants;
      session.lastError = undefined;
      applyAuthorityFromRoomState(session, state);

      if (
        session.pendingRemoteNavigation &&
        session.pendingRemoteNavigation.episodeId ===
          state.playback.episodeId &&
        session.localPlayback?.episodeId === state.playback.episodeId
      ) {
        session.pendingRemoteNavigation = undefined;
      }
      deliverRoomSnapshotToContent(session, state);
      return;
    }

    session.connectionState = "connected";
    session.roomId = state.roomId;
    session.roomRevision = state.revision;
    session.roomState = state;
    session.roomPlayback = state.playback;
    session.participantCount = state.participantCount;
    session.participants = state.participants;
    session.lastError = undefined;
    applyAuthorityFromRoomState(session, state);

    if (
      session.pendingRemoteNavigation &&
      session.pendingRemoteNavigation.episodeId === state.playback.episodeId &&
      session.localPlayback?.episodeId === state.playback.episodeId
    ) {
      session.pendingRemoteNavigation = undefined;
    }
    if (
      session.verificationTransaction &&
      session.verificationTransaction.revision < state.revision
    ) {
      clearVerificationTransaction(session);
    }

    deliverRoomSnapshotToContent(session, state);
  };

  const handleRoomJoined = (session: TabSession, payload: unknown) => {
    const parsed = parseRoomJoinedPayload(payload);
    if (!parsed) {
      session.connectionState = "error";
      session.lastError = "Received invalid room_joined payload.";
      publishRoomState(session);
      return;
    }

    session.connectionState = "connected";
    session.roomId = parsed.roomId;
    session.sessionId = parsed.sessionId;
    session.pendingRemoteNavigation = undefined;
    session.reconnectAttempt = 0;
    refreshCapabilities(session);

    applyIncomingRoomState(session, parsed.state);

    const shareUrl =
      session.tabUrl && session.roomId
        ? buildRoomInviteUrl(session.tabUrl, session.roomId)
        : undefined;

    if (shareUrl && session.roomPlayback) {
      void upsertRecentRoom({
        roomId: session.roomId,
        shareUrl,
        episodeTitle: session.roomPlayback.episodeTitle,
        episodeUrl: session.roomPlayback.episodeUrl,
        updatedAt: Date.now(),
      })
        .then(() => {
          queuePopupStatePublish();
        })
        .catch((error) => {
          console.error("Failed to save recent room", error);
        });
    }

    publishRoomState(session);
  };

  const handleStateSnapshot = (session: TabSession, payload: unknown) => {
    const parsed = parseStateSnapshotPayload(payload);
    if (!parsed) {
      session.connectionState = "error";
      session.lastError = "Received invalid state_snapshot payload.";
      publishRoomState(session);
      return;
    }

    applyIncomingRoomState(session, parsed.state, {
      allowSameRevisionReapply: true,
    });
    publishRoomState(session);
  };

  const handleRoomNavigation = (session: TabSession, payload: unknown) => {
    const parsed = parseRoomNavigationPayload(payload);
    if (!parsed) {
      session.connectionState = "error";
      session.lastError = "Received invalid room_navigation payload.";
      publishRoomState(session);
      return;
    }

    if (session.roomId && parsed.roomId !== session.roomId) {
      return;
    }

    if (
      session.navigationRevision !== undefined &&
      parsed.navigationRevision < session.navigationRevision
    ) {
      return;
    }

    session.roomRevision = Math.max(session.roomRevision ?? 0, parsed.revision);
    session.navigationRevision = parsed.navigationRevision;
    session.roomPlayback = parsed.playback;

    logSync("room_navigation_applied", {
      tabId: session.tabId,
      roomId: parsed.roomId,
      revision: parsed.revision,
      navigationRevision: parsed.navigationRevision,
      episodeId: parsed.playback.episodeId,
      initiatedBySessionId: parsed.initiatedBySessionId,
    });

    followRoomNavigation(session, parsed);
    publishRoomState(session);
  };

  const handlePresenceUpdate = (session: TabSession, payload: unknown) => {
    const parsed = parsePresenceUpdatePayload(payload);
    if (!parsed) {
      session.connectionState = "error";
      session.lastError = "Received invalid presence_update payload.";
      publishRoomState(session);
      return;
    }

    session.connectionState =
      session.roomId &&
      session.connectionState !== "connecting" &&
      session.connectionState !== "switching"
        ? "connected"
        : session.connectionState;
    session.participantCount = parsed.participantCount;
    session.participants = parsed.participants;
    const derivedHost = parsed.participants.find(
      (participant) => participant.isHost,
    )?.sessionId;
    if (derivedHost) {
      session.hostSessionId = derivedHost;
      refreshCapabilities(session);
    }
    if (
      session.roomRevision === undefined ||
      parsed.revision > session.roomRevision
    ) {
      session.roomRevision = parsed.revision;
    }
    publishRoomState(session);
  };

  const handleCommandError = (session: TabSession, payload: unknown) => {
    const parsed = parseCommandErrorPayload(payload);
    if (!parsed) {
      session.connectionState = "error";
      session.lastError = "Received invalid command_error payload.";
      publishRoomState(session);
      return;
    }

    session.connectionState = session.roomId ? "connected" : "error";
    session.lastError = parsed.message;
    logSync("command_error", {
      tabId: session.tabId,
      roomId: session.roomId,
      code: parsed.code,
      message: parsed.message,
    });
    publishRoomState(session);
  };

  const handlePlayerState = (
    session: TabSession,
    message: ContentPlayerStateMessage,
  ) => {
    const tx = session.verificationTransaction;
    if (tx) {
      if (
        message.commandId !== tx.commandId ||
        message.revision !== tx.revision ||
        message.roomId !== tx.roomId
      ) {
        return;
      }

      if (message.error) {
        finalizeVerification(session, "failed", message.error);
        return;
      }

      if (!message.playerState) {
        finalizeVerification(session, "failed", "Missing player state sample.");
        return;
      }

      const snapshot = message.playback ?? session.localPlayback;
      if (!snapshot) {
        finalizeVerification(
          session,
          "failed",
          "Missing playback snapshot while verifying state.",
        );
        return;
      }

      if (snapshot.episodeId !== tx.targetPlayback.episodeId) {
        finalizeVerification(
          session,
          "failed",
          "Local episode changed while verifying state convergence.",
        );
        return;
      }

      const evaluation = evaluatePlayerStateConvergence(
        {
          targetState: tx.targetState,
          expectedTime: resolveExpectedPlaybackTime(
            tx.targetPlayback,
            message.playerState.updatedAt,
          ),
          requiresSeek: tx.requiresSeek,
        },
        message.playerState,
        {
          playBaselineAt: tx.playBaselineAt,
          playBaselineTime: tx.playBaselineTime,
        },
        message.playerState.updatedAt,
      );

      tx.playBaselineAt = evaluation.progress.playBaselineAt;
      tx.playBaselineTime = evaluation.progress.playBaselineTime;
      session.localPlayback = snapshot;

      if (evaluation.converged) {
        logSync("verification converged", {
          tabId: session.tabId,
          revision: tx.revision,
          commandId: tx.commandId,
        });
        finalizeVerification(session, "applied", undefined, snapshot);
      }
      return;
    }

    const watchdog = session.watchdogPending;
    if (!watchdog) {
      return;
    }

    if (
      message.commandId !== watchdog.commandId ||
      message.revision !== watchdog.revision ||
      message.roomId !== watchdog.roomId
    ) {
      return;
    }

    session.watchdogPending = undefined;

    const localSample = message.playback;
    if (!localSample || !session.roomPlayback) {
      return;
    }
    session.localPlayback = localSample;

    if (localSample.episodeId !== session.roomPlayback.episodeId) {
      return;
    }

    if (
      needsPlaybackCorrection(
        localSample,
        session.roomPlayback,
        WATCHDOG_DRIFT_THRESHOLD_SECONDS,
      )
    ) {
      logSync("watchdog detected drift", {
        tabId: session.tabId,
        roomId: session.roomId,
        revision: session.roomRevision,
        localTime: localSample.currentTime,
        roomTime: session.roomPlayback.currentTime,
        localState: localSample.state,
        roomState: session.roomPlayback.state,
      });

      if (session.roomState) {
        applyIncomingRoomState(session, session.roomState, {
          allowSameRevisionReapply: true,
        });
      }

      const now = Date.now();
      if (
        !session.lastStateRequestAt ||
        now - session.lastStateRequestAt >= WATCHDOG_STATE_REQUEST_COOLDOWN_MS
      ) {
        session.lastStateRequestAt = now;
        requestCanonicalState(session);
      }

      publishRoomState(session);
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

    let endpoint: { baseUrl: string; path: string };
    try {
      endpoint = resolveSocketEndpoint(settings.backendWsUrl);
    } catch {
      session.connectionState = "error";
      session.lastError = "Backend socket URL is invalid.";
      publishRoomState(session);
      return;
    }
    const socket = io(endpoint.baseUrl, {
      path: endpoint.path,
      transports: ["websocket"],
      autoConnect: true,
      reconnection: false,
      timeout: 5_000,
    }) as SocketWithReconnectFlag;
    session.socket = socket;

    socket.on("connect", () => {
      if (session.socket !== socket || !session.localPlayback) {
        return;
      }

      session.reconnectAttempt = 0;
      socket.emit("join_room", {
        version: PROTOCOL_VERSION,
        roomId: requestedRoomId,
        sessionId: session.sessionId,
        displayName: settings.displayName,
        playback: session.localPlayback,
      });

      stopHeartbeat(session);
      session.pingInterval = setInterval(() => {
        if (!socket.connected) {
          return;
        }

        socket.emit("heartbeat", {
          version: PROTOCOL_VERSION,
          sentAt: Date.now(),
        });
      }, SOCKET_HEARTBEAT_INTERVAL_MS);

      startWatchdog(session);
    });

    socket.on("room_joined", (payload: unknown) => {
      if (session.socket !== socket) {
        return;
      }
      handleRoomJoined(session, payload);
    });

    socket.on("state_snapshot", (payload: unknown) => {
      if (session.socket !== socket) {
        return;
      }
      handleStateSnapshot(session, payload);
    });

    socket.on("room_navigation", (payload: unknown) => {
      if (session.socket !== socket) {
        return;
      }
      handleRoomNavigation(session, payload);
    });

    socket.on("presence_update", (payload: unknown) => {
      if (session.socket !== socket) {
        return;
      }
      handlePresenceUpdate(session, payload);
    });

    socket.on("command_error", (payload: unknown) => {
      if (session.socket !== socket) {
        return;
      }
      handleCommandError(session, payload);
    });

    socket.on("heartbeat_ack", (payload: unknown) => {
      if (session.socket !== socket) {
        return;
      }
      parseHeartbeatAckPayload(payload);
    });

    socket.on("connect_error", () => {
      if (session.socket !== socket) {
        return;
      }
      session.connectionState = "error";
      session.lastError = "Unable to reach the Roll Together backend.";
      publishRoomState(session);
    });

    socket.on("disconnect", () => {
      stopHeartbeat(session);
      stopWatchdog(session);

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

  const sendPlaybackCommand = (
    session: TabSession,
    command: "play" | "pause" | "seek",
    playback: PlaybackSnapshot,
  ) => {
    if (!session.socket || !session.socket.connected || !session.roomId) {
      return;
    }

    logSync("playback_command_emit", {
      tabId: session.tabId,
      roomId: session.roomId,
      command,
      state: playback.state,
      currentTime: playback.currentTime,
      updatedAt: playback.updatedAt,
    });

    session.socket.emit(command, {
      version: PROTOCOL_VERSION,
      playback,
    });
  };

  const sendNavigateEpisode = (
    session: TabSession,
    playback: PlaybackSnapshot,
  ) => {
    if (
      !session.socket ||
      !session.socket.connected ||
      !session.roomId ||
      !session.canNavigateEpisodes
    ) {
      return;
    }

    if (
      session.pendingRemoteNavigation?.episodeId === playback.episodeId ||
      session.roomPlayback?.episodeId === playback.episodeId
    ) {
      return;
    }

    session.pendingRemoteNavigation = undefined;
    session.connectionState = "switching";
    session.episodeMismatch = undefined;
    session.lastError = undefined;

    logSync("room_navigation_emit", {
      tabId: session.tabId,
      roomId: session.roomId,
      episodeId: playback.episodeId,
      episodeUrl: playback.episodeUrl,
    });

    session.socket.emit("navigate_episode", {
      version: PROTOCOL_VERSION,
      playback,
    });
    publishRoomState(session);
  };

  const setRoomControlMode = (
    session: TabSession,
    controlMode: "host_only" | "shared_playback",
  ) => {
    if (
      !session.socket ||
      !session.socket.connected ||
      !session.roomId ||
      !session.canTransferHost
    ) {
      return;
    }

    logSync("room_control_mode_emit", {
      tabId: session.tabId,
      roomId: session.roomId,
      controlMode,
    });

    session.socket.emit("set_room_control_mode", {
      version: PROTOCOL_VERSION,
      controlMode,
    });
  };

  const transferHost = (session: TabSession, targetSessionId: string) => {
    if (
      !session.socket ||
      !session.socket.connected ||
      !session.roomId ||
      !session.canTransferHost
    ) {
      return;
    }

    logSync("host_transfer_emit", {
      tabId: session.tabId,
      roomId: session.roomId,
      targetSessionId,
    });

    session.socket.emit("transfer_host", {
      version: PROTOCOL_VERSION,
      targetSessionId,
    });
  };

  const requestRoomState = (session: TabSession) => {
    requestCanonicalState(session);
  };

  return {
    closeSocket,
    connectSession,
    handlePlayerState,
    sendPlaybackCommand,
    sendNavigateEpisode,
    setRoomControlMode,
    transferHost,
    requestRoomState,
  };
}
