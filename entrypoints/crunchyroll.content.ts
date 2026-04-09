import { browser } from "wxt/browser";

import {
  CONTENT_PORT_NAME,
  type ApplyRemotePlaybackMessage,
  type ContentOutboundMessage,
  type ContentSnapshotReason,
  type PlayerRuntimeState,
  type QueryPlayerStateMessage,
} from "../src/core/messages";
import { buildSyncDecision } from "../src/core/reconcile";
import type { PlaybackSnapshot } from "../src/core/protocol";
import { getRoomIdFromUrl } from "../src/core/url";
import {
  extractEpisodeInfo,
  findCrunchyrollPlayer,
  seekCrunchyrollPlayer,
} from "../src/providers/crunchyroll/player";
import { detectLargeTimeDiscontinuity } from "../src/providers/crunchyroll/content-sync";
import { buildPlayerRuntimeState } from "../src/providers/crunchyroll/player-runtime";

export default defineContentScript({
  matches: ["*://crunchyroll.com/*", "*://*.crunchyroll.com/*"],
  allFrames: false,
  runAt: "document_idle",
  main() {
    const FAST_SCAN_DELAYS_MS = [0, 50, 125, 250, 500, 900, 1_400];
    const FALLBACK_SCAN_INTERVAL_MS = 2_000;
    const PAGE_KEY_POLL_INTERVAL_MS = 1_000;
    const KEEPALIVE_HEARTBEAT_INTERVAL_MS = 8_000;
    const TIME_JUMP_THRESHOLD_SECONDS = 3;
    const MAX_REMOTE_PLAY_RETRIES = 3;
    const REMOTE_PLAY_RETRY_DELAY_MS = 140;
    const SEEK_PLAY_GUARD_TIMEOUT_MS = 320;
    const APPLY_SETTLE_DELAY_MS = 220;
    const logSync = (message: string, details?: Record<string, unknown>) => {
      if (details) {
        console.log(`[rt-sync-content] ${message}`, details);
        return;
      }
      console.log(`[rt-sync-content] ${message}`);
    };

    const port = browser.runtime.connect({ name: CONTENT_PORT_NAME });

    let player: HTMLVideoElement | null = null;
    let disposePlayerListeners: (() => void) | undefined;
    let scanQueued = false;
    let scanBurstTimeoutIds: number[] = [];
    let lastPageKey = `${window.location.href}|${document.title}`;
    let lastObservedCurrentTime: number | undefined;
    let heartbeatIntervalId: number | undefined;
    let pagePollIntervalId: number | undefined;
    let fallbackScanIntervalId: number | undefined;
    let pendingRemoteMessage: ApplyRemotePlaybackMessage | undefined;
    let queuedRemoteMessage: ApplyRemotePlaybackMessage | undefined;
    let remoteApplyInFlight = false;
    let playPromise: Promise<void> | undefined;
    let lastAppliedRevision = 0;
    let suppressLocalEventsUntil = 0;
    let portDisconnected = false;

    const safePostMessage = (message: ContentOutboundMessage) => {
      if (portDisconnected) {
        return;
      }

      try {
        port.postMessage(message);
      } catch (error) {
        const errorMessage =
          error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : "";
        if (!errorMessage.includes("message channel is closed")) {
          console.error("Failed to post message to background", error);
        }
        portDisconnected = true;
      }
    };

    const buildRuntimeState = (): PlayerRuntimeState | null => {
      if (!player) {
        return null;
      }

      const episode = extractEpisodeInfo(window.location.href, document.title);
      return buildPlayerRuntimeState(player, episode.episodeId);
    };

    const buildSnapshot = (): PlaybackSnapshot | null => {
      const runtime = buildRuntimeState();
      if (!runtime) {
        return null;
      }
      const episode = extractEpisodeInfo(window.location.href, document.title);
      return {
        ...episode,
        state: runtime.paused ? "paused" : "playing",
        currentTime: runtime.currentTime,
        duration: runtime.duration,
        playbackRate: runtime.playbackRate,
        updatedAt: runtime.updatedAt,
      };
    };

    const postSnapshot = (reason: ContentSnapshotReason) => {
      if (remoteApplyInFlight && reason !== "heartbeat") {
        return;
      }

      if (Date.now() < suppressLocalEventsUntil && reason !== "heartbeat") {
        return;
      }

      const snapshot = buildSnapshot();
      if (!snapshot) {
        return;
      }

      safePostMessage({
        type: "content:snapshot",
        tabUrl: window.location.href,
        episode: extractEpisodeInfo(window.location.href, document.title),
        playback: snapshot,
        playerState: buildRuntimeState() ?? undefined,
        roomIdFromUrl: getRoomIdFromUrl(window.location.href),
        reason,
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

    const finishRemoteApply = (revision?: number) => {
      if (revision !== undefined) {
        lastAppliedRevision = Math.max(lastAppliedRevision, revision);
      }
      remoteApplyInFlight = false;
      suppressLocalEventsUntil = Date.now() + 250;
      applyNextQueuedRemoteIfAny();
    };

    const applyRemotePlayback = (message: ApplyRemotePlaybackMessage) => {
      if (message.revision < lastAppliedRevision) {
        return;
      }

      if (remoteApplyInFlight) {
        queueLatestRemoteMessage(message);
        return;
      }

      const snapshot = buildSnapshot();
      if (!player || !snapshot) {
        setPendingRemoteMessage(message);
        return;
      }

      if (snapshot.episodeId !== message.playback.episodeId) {
        return;
      }

      const decision = buildSyncDecision(
        snapshot,
        message.playback,
        message.driftThresholdSeconds,
      );
      if (
        !decision.shouldPause &&
        !decision.shouldPlay &&
        !decision.shouldSeek
      ) {
        lastAppliedRevision = Math.max(lastAppliedRevision, message.revision);
        logSync("skip remote apply (already converged)", {
          revision: message.revision,
          roomId: message.roomId,
        });
        return;
      }

      remoteApplyInFlight = true;
      suppressLocalEventsUntil = Date.now() + 900;

      const delay = (ms: number) =>
        new Promise<void>((resolve) => {
          window.setTimeout(resolve, ms);
        });

      const waitForSeekSettle = async () => {
        if (!player || !player.seeking) {
          return;
        }

        const seekTarget = player;
        await new Promise<void>((resolve) => {
          let settled = false;
          const settle = () => {
            if (settled) {
              return;
            }
            settled = true;
            seekTarget.removeEventListener("seeked", settle);
            seekTarget.removeEventListener("canplay", settle);
            window.clearTimeout(timeoutId);
            resolve();
          };

          seekTarget.addEventListener("seeked", settle, { once: true });
          seekTarget.addEventListener("canplay", settle, { once: true });
          const timeoutId = window.setTimeout(settle, SEEK_PLAY_GUARD_TIMEOUT_MS);
        });
      };

      const playWithRetry = async () => {
        for (let attempt = 1; attempt <= MAX_REMOTE_PLAY_RETRIES; attempt += 1) {
          if (!player) {
            return false;
          }

          playPromise = player.play();
          try {
            await playPromise;
            return true;
          } catch (error: unknown) {
            const domError =
              typeof DOMException !== "undefined" && error instanceof DOMException
                ? error
                : undefined;
            const canRetryAbort =
              domError?.name === "AbortError" &&
              attempt < MAX_REMOTE_PLAY_RETRIES;

            if (canRetryAbort) {
              logSync("retrying interrupted play()", {
                revision: message.revision,
                roomId: message.roomId,
                attempt,
              });
              await delay(REMOTE_PLAY_RETRY_DELAY_MS);
              continue;
            }

            if (error instanceof Error && error.message.trim().length > 0) {
              console.warn("Remote play request failed", error.message);
            }
            return false;
          } finally {
            playPromise = undefined;
          }
        }

        return false;
      };

      const runApply = async () => {
        if (!player) {
          finishRemoteApply();
          return;
        }

        const targetStateIsPlaying = message.playback.state === "playing";
        logSync("applying remote snapshot", {
          revision: message.revision,
          roomId: message.roomId,
          targetState: message.playback.state,
          targetTime: decision.targetTime,
          shouldSeek: decision.shouldSeek,
          shouldPlay: decision.shouldPlay,
          shouldPause: decision.shouldPause,
        });

        if (decision.shouldSeek) {
          if (!targetStateIsPlaying && !player.paused) {
            player.pause();
          }
          const seekResult = seekCrunchyrollPlayer(player, decision.targetTime);
          logSync("applied seek strategy", {
            revision: message.revision,
            roomId: message.roomId,
            method: seekResult.method,
            targetTime: seekResult.targetTime,
          });
        } else if (decision.shouldPause) {
          player.pause();
        }

        if (targetStateIsPlaying && (decision.shouldSeek || decision.shouldPlay)) {
          await waitForSeekSettle();
          await playWithRetry();
        }

        window.setTimeout(() => {
          logSync("remote apply settled", {
            revision: message.revision,
            roomId: message.roomId,
          });
          finishRemoteApply(message.revision);
        }, APPLY_SETTLE_DELAY_MS);
      };

      void (async () => {
        if (playPromise) {
          try {
            await playPromise;
          } catch {
            // Ignore: play promise interruption is expected during remote transitions.
          }
        }
        await runApply();
      })();
    };

    const respondToPlayerStateQuery = (message: QueryPlayerStateMessage) => {
      const playerState = buildRuntimeState() ?? undefined;
      const playback = buildSnapshot() ?? undefined;

      safePostMessage({
        type: "content:player-state",
        commandId: message.commandId,
        roomId: message.roomId,
        revision: message.revision,
        playerState,
        playback,
        error: playerState ? undefined : "Player unavailable.",
      });
    };

    const tryApplyPendingRemote = () => {
      applyNextQueuedRemoteIfAny();
    };

    const detachPlayer = () => {
      disposePlayerListeners?.();
      disposePlayerListeners = undefined;
      player = null;
      lastObservedCurrentTime = undefined;
    };

    const attachPlayer = (candidate: HTMLVideoElement) => {
      if (player === candidate) {
        return;
      }

      detachPlayer();
      clearScanBurst();
      player = candidate;
      const cleanups: Array<() => void> = [];

      const addListener = (
        eventName: keyof HTMLMediaElementEventMap,
        handler: () => void,
      ) => {
        candidate.addEventListener(eventName, handler);
        cleanups.push(() => {
          candidate.removeEventListener(eventName, handler);
        });
      };

      addListener("play", () => postSnapshot("play"));
      addListener("pause", () => postSnapshot("pause"));
      addListener("seeked", () => postSnapshot("seeked"));

      addListener("timeupdate", () => {
        const currentTime = candidate.currentTime;
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
      });

      addListener("playing", () => {
        tryApplyPendingRemote();
      });
      addListener("canplay", () => {
        tryApplyPendingRemote();
      });
      addListener("loadeddata", () => {
        tryApplyPendingRemote();
      });

      disposePlayerListeners = () => {
        for (const cleanup of cleanups) {
          cleanup();
        }
      };

      postSnapshot("initial");
      tryApplyPendingRemote();
    };

    const clearScanBurst = () => {
      for (const timeoutId of scanBurstTimeoutIds) {
        window.clearTimeout(timeoutId);
      }
      scanBurstTimeoutIds = [];
    };

    const scanForPlayer = () => {
      if (player?.isConnected) {
        return;
      }

      if (player && !player.isConnected) {
        detachPlayer();
      }

      const candidate = findCrunchyrollPlayer(document);
      if (candidate) {
        attachPlayer(candidate);
      }
    };

    const scheduleScanBurst = () => {
      clearScanBurst();

      for (const delayMs of FAST_SCAN_DELAYS_MS) {
        const timeoutId = window.setTimeout(() => {
          scanForPlayer();
          if (player) {
            clearScanBurst();
          }
        }, delayMs);

        scanBurstTimeoutIds.push(timeoutId);
      }
    };

    const scheduleScan = () => {
      if (scanQueued) {
        return;
      }

      scanQueued = true;
      window.setTimeout(() => {
        scanQueued = false;
        scanForPlayer();
        if (!player) {
          scheduleScanBurst();
        }
      }, 0);
    };

    const handlePageChange = () => {
      const nextPageKey = `${window.location.href}|${document.title}`;
      if (nextPageKey === lastPageKey) {
        return;
      }

      lastPageKey = nextPageKey;
      detachPlayer();
      scheduleScanBurst();
      postSnapshot("initial");
    };

    const originalPushState = history.pushState.bind(history);
    const originalReplaceState = history.replaceState.bind(history);
    const queuePageChangeCheck = () => {
      window.setTimeout(handlePageChange, 0);
    };

    history.pushState = (...args) => {
      originalPushState(...args);
      queuePageChangeCheck();
    };

    history.replaceState = (...args) => {
      originalReplaceState(...args);
      queuePageChangeCheck();
    };

    window.addEventListener("popstate", queuePageChangeCheck);
    pagePollIntervalId = window.setInterval(
      handlePageChange,
      PAGE_KEY_POLL_INTERVAL_MS,
    );

    fallbackScanIntervalId = window.setInterval(() => {
      if (!player || !player.isConnected) {
        scheduleScan();
      }
    }, FALLBACK_SCAN_INTERVAL_MS);

    heartbeatIntervalId = window.setInterval(() => {
      postSnapshot("heartbeat");
    }, KEEPALIVE_HEARTBEAT_INTERVAL_MS);

    port.onMessage.addListener((message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null
      ) {
        const typedMessage = message as { type?: string };
        if (typedMessage.type === "background:apply-state-snapshot") {
          applyRemotePlayback(message as ApplyRemotePlaybackMessage);
          return;
        }
        if (typedMessage.type === "background:query-player-state") {
          respondToPlayerStateQuery(message as QueryPlayerStateMessage);
        }
      }
    });

    port.onDisconnect.addListener(() => {
      portDisconnected = true;
      detachPlayer();
      clearScanBurst();
      if (fallbackScanIntervalId) {
        window.clearInterval(fallbackScanIntervalId);
        fallbackScanIntervalId = undefined;
      }
      if (pagePollIntervalId) {
        window.clearInterval(pagePollIntervalId);
        pagePollIntervalId = undefined;
      }
      if (heartbeatIntervalId) {
        window.clearInterval(heartbeatIntervalId);
        heartbeatIntervalId = undefined;
      }
    });

    scheduleScanBurst();
  },
});
