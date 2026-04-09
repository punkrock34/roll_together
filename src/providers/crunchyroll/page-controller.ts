import type {
  ApplyRemotePlaybackMessage,
  ContentSnapshotReason,
  PlayerRuntimeState,
  QueryPlayerStateMessage,
} from "../../core/messages";
import type { PlaybackSnapshot } from "../../core/protocol";
import { buildSyncDecision } from "../../core/reconcile";
import { getRoomIdFromUrl } from "../../core/url";

import { createCrunchyrollPlayerAdapter } from "./adapter";
import type {
  BridgeContentToPageMessage,
  BridgePageToContentMessage,
} from "./bridge-messages";
import { createBridgeEnvelope } from "./bridge-messages";

const PAGE_KEY_POLL_INTERVAL_MS = 1_000;
const KEEPALIVE_HEARTBEAT_INTERVAL_MS = 8_000;
const TIME_JUMP_THRESHOLD_SECONDS = 3;
const MAX_REMOTE_PLAY_RETRIES = 3;
const REMOTE_PLAY_RETRY_DELAY_MS = 140;
const SEEK_PLAY_GUARD_TIMEOUT_MS = 320;
const APPLY_SETTLE_DELAY_MS = 220;
const ENABLE_PAGE_SYNC_LOGS = false;

export interface CrunchyrollPageControllerOptions {
  bridgeId: string;
  postMessage: (message: BridgePageToContentMessage) => void;
}

export interface CrunchyrollPageController {
  handleBridgeMessage: (message: BridgeContentToPageMessage) => void;
  cleanup: () => void;
}

function detectLargeTimeDiscontinuity(
  previousTime: number | undefined,
  nextTime: number,
  thresholdSeconds: number,
): boolean {
  if (previousTime === undefined) {
    return false;
  }

  return Math.abs(nextTime - previousTime) > thresholdSeconds;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function createCrunchyrollPageController({
  bridgeId,
  postMessage,
}: CrunchyrollPageControllerOptions): CrunchyrollPageController {
  const adapter = createCrunchyrollPlayerAdapter();
  const abortController = new AbortController();

  const log = (message: string, details?: Record<string, unknown>) => {
    if (!ENABLE_PAGE_SYNC_LOGS) {
      return;
    }

    if (details) {
      console.log(`[rt-page] ${message}`, details);
      return;
    }

    console.log(`[rt-page] ${message}`);
  };

  let heartbeatIntervalId: number | undefined;
  let pagePollIntervalId: number | undefined;
  let lastPageKey = `${window.location.href}|${document.title}`;
  let lastObservedCurrentTime: number | undefined;
  let pendingRemoteMessage: ApplyRemotePlaybackMessage | undefined;
  let queuedRemoteMessage: ApplyRemotePlaybackMessage | undefined;
  let remoteApplyInFlight = false;
  let lastAppliedRevision = 0;
  let suppressLocalEventsUntil = 0;
  let cleanedUp = false;

  const emit = <TType extends BridgePageToContentMessage["type"]>(
    type: TType,
    payload: Extract<BridgePageToContentMessage, { type: TType }>["payload"],
  ) => {
    if (cleanedUp) {
      return;
    }

    postMessage(
      createBridgeEnvelope(
        bridgeId,
        type,
        payload,
      ) as BridgePageToContentMessage,
    );
  };

  const buildRuntimeState = (): PlayerRuntimeState | null => {
    const runtimeSample = adapter.getRuntimeSample();
    if (!runtimeSample) {
      return null;
    }

    return {
      ...runtimeSample,
      episodeId: adapter.getMediaIdentity().episodeId,
      updatedAt: Date.now(),
    };
  };

  const buildSnapshot = (): PlaybackSnapshot | null => {
    const runtimeState = buildRuntimeState();
    if (!runtimeState) {
      return null;
    }

    const media = adapter.getMediaIdentity();
    return {
      ...media,
      state: runtimeState.paused ? "paused" : "playing",
      currentTime: runtimeState.currentTime,
      duration: runtimeState.duration,
      playbackRate: runtimeState.playbackRate,
      updatedAt: runtimeState.updatedAt,
    };
  };

  const postSnapshot = (reason: ContentSnapshotReason) => {
    if (
      remoteApplyInFlight &&
      reason !== "heartbeat" &&
      reason !== "remote-apply"
    ) {
      return;
    }

    if (
      Date.now() < suppressLocalEventsUntil &&
      reason !== "heartbeat" &&
      reason !== "remote-apply"
    ) {
      return;
    }

    const playback = buildSnapshot();
    if (!playback) {
      return;
    }

    emit("bridge:snapshot", {
      tabUrl: window.location.href,
      roomIdFromUrl: getRoomIdFromUrl(window.location.href),
      reason,
      playback,
      playerState: buildRuntimeState() ?? undefined,
    });
  };

  const queueLatestRemoteMessage = (message: ApplyRemotePlaybackMessage) => {
    if (
      !queuedRemoteMessage ||
      message.revision >= queuedRemoteMessage.revision
    ) {
      queuedRemoteMessage = message;
    }
  };

  const setPendingRemoteMessage = (message: ApplyRemotePlaybackMessage) => {
    if (
      !pendingRemoteMessage ||
      message.revision >= pendingRemoteMessage.revision
    ) {
      pendingRemoteMessage = message;
    }
  };

  const applyNextQueuedRemoteIfAny = () => {
    if (remoteApplyInFlight) {
      return;
    }

    let next: ApplyRemotePlaybackMessage | undefined;

    if (
      queuedRemoteMessage &&
      queuedRemoteMessage.revision > lastAppliedRevision
    ) {
      next = queuedRemoteMessage;
    }
    queuedRemoteMessage = undefined;

    if (
      pendingRemoteMessage &&
      pendingRemoteMessage.revision > lastAppliedRevision &&
      (!next || pendingRemoteMessage.revision >= next.revision)
    ) {
      next = pendingRemoteMessage;
    }
    pendingRemoteMessage = undefined;

    if (next) {
      applyRemotePlayback(next);
    }
  };

  const emitCommandResult = (
    message: ApplyRemotePlaybackMessage,
    status: "applied" | "failed" | "timed_out",
    errorMessage?: string,
  ) => {
    emit("bridge:command-result", {
      message: {
        type: "content:command-result",
        commandId: message.commandId,
        revision: message.revision,
        status,
        message: errorMessage,
        snapshot: buildSnapshot() ?? undefined,
      },
    });
  };

  const finishRemoteApply = (
    remoteMessage: ApplyRemotePlaybackMessage,
    revision?: number,
  ) => {
    if (revision !== undefined) {
      lastAppliedRevision = Math.max(lastAppliedRevision, revision);
      emitCommandResult(remoteMessage, "applied");
    }

    remoteApplyInFlight = false;
    suppressLocalEventsUntil = Date.now() + 250;
    postSnapshot("remote-apply");
    applyNextQueuedRemoteIfAny();
  };

  const waitForSeekSettle = async () => {
    if (!adapter.isSeeking()) {
      return;
    }

    const deadlineAt = Date.now() + SEEK_PLAY_GUARD_TIMEOUT_MS;
    while (Date.now() < deadlineAt && adapter.isSeeking()) {
      await delay(50);
    }
  };

  const playWithRetry = async (message: ApplyRemotePlaybackMessage) => {
    for (let attempt = 1; attempt <= MAX_REMOTE_PLAY_RETRIES; attempt += 1) {
      const didPlay = await adapter.play();
      if (didPlay) {
        return true;
      }

      if (attempt < MAX_REMOTE_PLAY_RETRIES) {
        log("retrying interrupted play()", {
          revision: message.revision,
          roomId: message.roomId,
          attempt,
          bridgeId,
        });
        await delay(REMOTE_PLAY_RETRY_DELAY_MS);
      }
    }

    return false;
  };

  const applyRemotePlayback = (message: ApplyRemotePlaybackMessage) => {
    if (message.revision < lastAppliedRevision) {
      return;
    }

    if (remoteApplyInFlight) {
      queueLatestRemoteMessage(message);
      return;
    }

    if (adapter.isInAd()) {
      setPendingRemoteMessage(message);
      return;
    }

    const localSnapshot = buildSnapshot();
    if (!adapter.isReady() || !localSnapshot) {
      setPendingRemoteMessage(message);
      return;
    }

    if (localSnapshot.episodeId !== message.playback.episodeId) {
      return;
    }

    const decision = buildSyncDecision(
      localSnapshot,
      message.playback,
      message.driftThresholdSeconds,
    );
    if (!decision.shouldPause && !decision.shouldPlay && !decision.shouldSeek) {
      lastAppliedRevision = Math.max(lastAppliedRevision, message.revision);
      log("skip remote apply (already converged)", {
        revision: message.revision,
        roomId: message.roomId,
        bridgeId,
      });
      emitCommandResult(message, "applied");
      return;
    }

    remoteApplyInFlight = true;
    suppressLocalEventsUntil = Date.now() + 900;

    const runApply = async () => {
      const targetStateIsPlaying = message.playback.state === "playing";

      log("applying remote snapshot", {
        revision: message.revision,
        roomId: message.roomId,
        bridgeId,
        targetState: message.playback.state,
        targetTime: decision.targetTime,
        shouldSeek: decision.shouldSeek,
        shouldPlay: decision.shouldPlay,
        shouldPause: decision.shouldPause,
      });

      if (decision.shouldSeek) {
        if (!targetStateIsPlaying && adapter.getPlaybackState() === "playing") {
          adapter.pause();
        }

        const seekResult = adapter.seekTo(decision.targetTime);
        log("applied seek strategy", {
          revision: message.revision,
          roomId: message.roomId,
          bridgeId,
          method: seekResult.method,
          targetTime: seekResult.targetTime,
        });
      } else if (decision.shouldPause) {
        adapter.pause();
      }

      if (
        targetStateIsPlaying &&
        (decision.shouldSeek || decision.shouldPlay)
      ) {
        await waitForSeekSettle();
        const didPlay = await playWithRetry(message);
        if (!didPlay) {
          emitCommandResult(
            message,
            "failed",
            "Failed to play while applying remote snapshot.",
          );
          finishRemoteApply(message);
          return;
        }
      }

      window.setTimeout(() => {
        log("remote apply settled", {
          revision: message.revision,
          roomId: message.roomId,
          bridgeId,
        });
        finishRemoteApply(message, message.revision);
      }, APPLY_SETTLE_DELAY_MS);
    };

    void runApply().catch((error) => {
      console.error("Failed to apply remote playback", error);
      emit("bridge:error", {
        code: "apply_failed",
        message:
          error instanceof Error
            ? error.message
            : "Unexpected apply failure in page controller.",
      });
      emitCommandResult(message, "failed", "Failed to apply remote playback.");
      remoteApplyInFlight = false;
      suppressLocalEventsUntil = Date.now() + 250;
      applyNextQueuedRemoteIfAny();
    });
  };

  const respondToPlayerStateQuery = (message: QueryPlayerStateMessage) => {
    const playerState = buildRuntimeState() ?? undefined;
    const playback = buildSnapshot() ?? undefined;

    emit("bridge:player-state", {
      message: {
        type: "content:player-state",
        commandId: message.commandId,
        roomId: message.roomId,
        revision: message.revision,
        playerState,
        playback,
        error: playerState ? undefined : "Player unavailable.",
      },
    });
  };

  const handlePageChange = () => {
    const nextPageKey = `${window.location.href}|${document.title}`;
    if (nextPageKey === lastPageKey) {
      return;
    }

    lastPageKey = nextPageKey;
    lastObservedCurrentTime = undefined;
    adapter.requestScanBurst();
    postSnapshot("initial");
  };

  const queuePageChangeCheck = () => {
    window.setTimeout(handlePageChange, 0);
  };

  adapter.attachListeners({
    onPlayerChanged: (ready) => {
      if (ready) {
        postSnapshot("initial");
        applyNextQueuedRemoteIfAny();
      }
    },
    onPlay: () => {
      postSnapshot("play");
    },
    onPause: () => {
      postSnapshot("pause");
    },
    onSeeked: () => {
      postSnapshot("seeked");
    },
    onTimeUpdate: (currentTime) => {
      if (
        detectLargeTimeDiscontinuity(
          lastObservedCurrentTime,
          currentTime,
          TIME_JUMP_THRESHOLD_SECONDS,
        )
      ) {
        postSnapshot("discontinuity");
      }

      lastObservedCurrentTime = currentTime;
    },
    onPlaying: () => {
      applyNextQueuedRemoteIfAny();
    },
    onCanPlay: () => {
      applyNextQueuedRemoteIfAny();
    },
    onLoadedData: () => {
      applyNextQueuedRemoteIfAny();
    },
  });

  pagePollIntervalId = window.setInterval(
    handlePageChange,
    PAGE_KEY_POLL_INTERVAL_MS,
  );
  heartbeatIntervalId = window.setInterval(() => {
    postSnapshot("heartbeat");
  }, KEEPALIVE_HEARTBEAT_INTERVAL_MS);

  window.addEventListener("popstate", queuePageChangeCheck, {
    signal: abortController.signal,
  });
  window.addEventListener("hashchange", queuePageChangeCheck, {
    signal: abortController.signal,
  });

  const navigationApi = (
    globalThis as typeof globalThis & {
      navigation?: {
        addEventListener?: (
          type: string,
          listener: EventListenerOrEventListenerObject,
          options?: AddEventListenerOptions,
        ) => void;
      };
    }
  ).navigation;

  if (typeof navigationApi?.addEventListener === "function") {
    navigationApi.addEventListener("navigate", queuePageChangeCheck, {
      signal: abortController.signal,
    });
  }

  const handleBridgeMessage = (message: BridgeContentToPageMessage) => {
    if (cleanedUp) {
      return;
    }

    if (message.type === "bridge:init") {
      emit("bridge:ready", {
        tabUrl: window.location.href,
        issuedAt: Date.now(),
      });
      adapter.requestScanBurst();
      return;
    }

    if (message.type === "bridge:apply-remote") {
      applyRemotePlayback(message.payload.message);
      return;
    }

    if (message.type === "bridge:query-player-state") {
      respondToPlayerStateQuery(message.payload.message);
      return;
    }

    if (message.type === "bridge:teardown") {
      cleanup();
    }
  };

  const cleanup = () => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;
    abortController.abort();

    if (pagePollIntervalId !== undefined) {
      window.clearInterval(pagePollIntervalId);
      pagePollIntervalId = undefined;
    }

    if (heartbeatIntervalId !== undefined) {
      window.clearInterval(heartbeatIntervalId);
      heartbeatIntervalId = undefined;
    }

    adapter.cleanup();
    pendingRemoteMessage = undefined;
    queuedRemoteMessage = undefined;
  };

  return {
    handleBridgeMessage,
    cleanup,
  };
}
