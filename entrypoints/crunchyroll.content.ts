import { browser } from "wxt/browser";

import {
  CONTENT_PORT_NAME,
  type ApplyRemotePlaybackMessage,
  type ContentOutboundMessage,
  type ContentSnapshotReason,
} from "../src/core/messages";
import { buildSyncDecision } from "../src/core/reconcile";
import type { PlaybackSnapshot } from "../src/core/protocol";
import { getRoomIdFromUrl } from "../src/core/url";
import {
  extractEpisodeInfo,
  findCrunchyrollPlayer,
} from "../src/providers/crunchyroll/player";
import {
  consumeRemoteEchoExpectation,
  createRemoteEchoExpectation,
  type RemoteEchoExpectation,
} from "../src/providers/crunchyroll/remote-echo";

export default defineContentScript({
  matches: ["*://crunchyroll.com/*", "*://*.crunchyroll.com/*"],
  allFrames: true,
  runAt: "document_idle",
  main() {
    const FAST_SCAN_DELAYS_MS = [0, 50, 125, 250, 500, 900, 1_400];
    const FALLBACK_SCAN_INTERVAL_MS = 2_000;
    const PAGE_KEY_POLL_INTERVAL_MS = 1_000;
    const KEEPALIVE_HEARTBEAT_INTERVAL_MS = 15_000;
    const TIME_JUMP_THRESHOLD_SECONDS = 3;
    const port = browser.runtime.connect({ name: CONTENT_PORT_NAME });

    let player: HTMLVideoElement | null = null;
    let disposePlayerListeners: (() => void) | undefined;
    let scanQueued = false;
    let scanBurstTimeoutIds: number[] = [];
    let lastPageKey = `${window.location.href}|${document.title}`;
    let lastObservedCurrentTime: number | undefined;
    let pendingRemotePlayback: ApplyRemotePlaybackMessage | undefined;
    let pendingRemoteRetryTimeoutId: number | undefined;
    let pendingRemoteRetryCount = 0;
    let playPromise: Promise<void> | undefined;
    let expectedRemoteEcho: RemoteEchoExpectation | undefined;

    const clearPendingRemoteRetry = () => {
      if (pendingRemoteRetryTimeoutId) {
        window.clearTimeout(pendingRemoteRetryTimeoutId);
        pendingRemoteRetryTimeoutId = undefined;
      }
    };

    const clearPendingRemotePlayback = () => {
      pendingRemotePlayback = undefined;
      pendingRemoteRetryCount = 0;
      clearPendingRemoteRetry();
    };

    const isSameRemotePlayback = (
      left: ApplyRemotePlaybackMessage | undefined,
      right: ApplyRemotePlaybackMessage,
    ) => {
      if (!left) {
        return false;
      }

      return (
        left.roomId === right.roomId &&
        left.hostSessionId === right.hostSessionId &&
        left.playback.episodeUrl === right.playback.episodeUrl &&
        left.playback.state === right.playback.state &&
        left.playback.currentTime === right.playback.currentTime &&
        left.playback.updatedAt === right.playback.updatedAt
      );
    };

    const schedulePendingRemotePlaybackRetry = (delayMs = 500) => {
      if (!pendingRemotePlayback || pendingRemoteRetryCount >= 6) {
        return;
      }

      clearPendingRemoteRetry();
      pendingRemoteRetryTimeoutId = window.setTimeout(() => {
        pendingRemoteRetryTimeoutId = undefined;
        pendingRemoteRetryCount += 1;
        if (pendingRemotePlayback) {
          applyRemotePlayback(pendingRemotePlayback, true);
        }
      }, delayMs);
    };

    const tryApplyPendingRemotePlayback = (isRetry = false) => {
      if (!pendingRemotePlayback) {
        return;
      }

      applyRemotePlayback(pendingRemotePlayback, isRetry);
    };

    const buildSnapshot = (): PlaybackSnapshot | null => {
      if (!player) {
        return null;
      }

      const episode = extractEpisodeInfo(window.location.href, document.title);

      return {
        ...episode,
        state: player.paused ? "paused" : "playing",
        currentTime: player.currentTime,
        duration: Number.isFinite(player.duration) ? player.duration : null,
        playbackRate: player.playbackRate,
        updatedAt: Date.now(),
      };
    };

    const sendSnapshot = (
      snapshot: PlaybackSnapshot,
      reason: ContentSnapshotReason,
    ) => {
      const message: ContentOutboundMessage = {
        type: "content:snapshot",
        tabUrl: window.location.href,
        episode: extractEpisodeInfo(window.location.href, document.title),
        playback: snapshot,
        roomIdFromUrl: getRoomIdFromUrl(window.location.href),
        reason,
      };

      port.postMessage(message);
    };

    const postSnapshot = (
      reason: ContentSnapshotReason,
      options?: { suppressRemoteEcho: boolean },
    ) => {
      const snapshot = buildSnapshot();
      if (!snapshot) {
        return;
      }

      if (options?.suppressRemoteEcho) {
        const echoResult = consumeRemoteEchoExpectation(
          expectedRemoteEcho,
          snapshot,
        );
        expectedRemoteEcho = echoResult.nextExpectation;
        if (echoResult.shouldSuppress) {
          return;
        }
      }

      sendSnapshot(snapshot, reason);
    };

    const handleLocalChange = () => {
      postSnapshot("interaction", { suppressRemoteEcho: true });
    };

    const applyRemotePlayback = (
      message: ApplyRemotePlaybackMessage,
      isRetry = false,
    ) => {
      if (!isRetry && !isSameRemotePlayback(pendingRemotePlayback, message)) {
        pendingRemoteRetryCount = 0;
        clearPendingRemoteRetry();
      }

      pendingRemotePlayback = message;

      const snapshot = buildSnapshot();
      if (!player || !snapshot) {
        return;
      }

      const decision = buildSyncDecision(snapshot, message.playback);
      if (
        !decision.shouldPause &&
        !decision.shouldPlay &&
        !decision.shouldSeek
      ) {
        clearPendingRemotePlayback();
        expectedRemoteEcho = undefined;
        return;
      }

      expectedRemoteEcho = createRemoteEchoExpectation(
        message.playback,
        decision,
      );

      if (decision.shouldSeek) {
        player.currentTime = decision.targetTime;
      }

      if (decision.shouldPause) {
        const pausePlayer = () => {
          if (!player) {
            return;
          }

          player.pause();
          if (decision.shouldSeek) {
            player.currentTime = decision.targetTime;
          }
          clearPendingRemotePlayback();
        };

        if (playPromise) {
          void playPromise.finally(() => {
            playPromise = undefined;
            pausePlayer();
          });
        } else {
          pausePlayer();
        }
        return;
      }

      if (decision.shouldPlay) {
        playPromise = player.play();
        void playPromise
          .catch(() => undefined)
          .finally(() => {
            playPromise = undefined;
            schedulePendingRemotePlaybackRetry();
          });
      }

      schedulePendingRemotePlaybackRetry(750);
    };

    const detachPlayer = () => {
      disposePlayerListeners?.();
      disposePlayerListeners = undefined;
      player = null;
      lastObservedCurrentTime = undefined;
      expectedRemoteEcho = undefined;
    };

    const attachPlayer = (candidate: HTMLVideoElement) => {
      if (player === candidate) {
        return;
      }

      detachPlayer();
      clearScanBurst();
      clearPendingRemoteRetry();
      player = candidate;
      const cleanups: Array<() => void> = [];

      const localEvents = [
        "play",
        "pause",
        "seeked",
        "ratechange",
        "loadedmetadata",
        "durationchange",
      ] as const;
      for (const eventName of localEvents) {
        candidate.addEventListener(eventName, handleLocalChange);
        cleanups.push(() => {
          candidate.removeEventListener(eventName, handleLocalChange);
        });
      }

      const handlePlaybackReady = () => {
        tryApplyPendingRemotePlayback();
      };
      candidate.addEventListener("playing", handlePlaybackReady);
      candidate.addEventListener("canplay", handlePlaybackReady);
      candidate.addEventListener("loadeddata", handlePlaybackReady);
      cleanups.push(() => {
        candidate.removeEventListener("playing", handlePlaybackReady);
        candidate.removeEventListener("canplay", handlePlaybackReady);
        candidate.removeEventListener("loadeddata", handlePlaybackReady);
      });

      const handleTimeUpdate = () => {
        const currentTime = candidate.currentTime;
        if (
          lastObservedCurrentTime !== undefined &&
          Math.abs(currentTime - lastObservedCurrentTime) >
            TIME_JUMP_THRESHOLD_SECONDS
        ) {
          postSnapshot("interaction", { suppressRemoteEcho: true });
        }

        lastObservedCurrentTime = currentTime;
      };
      candidate.addEventListener("timeupdate", handleTimeUpdate);
      cleanups.push(() => {
        candidate.removeEventListener("timeupdate", handleTimeUpdate);
      });

      disposePlayerListeners = () => {
        for (const cleanup of cleanups) {
          cleanup();
        }
      };

      postSnapshot("initial");
      tryApplyPendingRemotePlayback();
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
      postSnapshot("navigation");
    };

    const originalPushState = history.pushState.bind(history);
    const originalReplaceState = history.replaceState.bind(history);
    const queuePageChangeCheck = () => {
      window.setTimeout(handlePageChange, 0);
    };

    history.pushState = ((...args: Parameters<History["pushState"]>) => {
      const result = originalPushState(...args);
      queuePageChangeCheck();
      return result;
    }) as History["pushState"];

    history.replaceState = ((...args: Parameters<History["replaceState"]>) => {
      const result = originalReplaceState(...args);
      queuePageChangeCheck();
      return result;
    }) as History["replaceState"];

    const handlePopState = () => {
      queuePageChangeCheck();
    };
    window.addEventListener("popstate", handlePopState);
    window.addEventListener("pageshow", handlePopState);
    const pageKeyPollIntervalId = window.setInterval(
      handlePageChange,
      PAGE_KEY_POLL_INTERVAL_MS,
    );
    const fallbackScanIntervalId = window.setInterval(() => {
      if (!player) {
        scanForPlayer();
      }
    }, FALLBACK_SCAN_INTERVAL_MS);
    const heartbeatIntervalId = window.setInterval(() => {
      postSnapshot("heartbeat");
    }, KEEPALIVE_HEARTBEAT_INTERVAL_MS);

    const observer = new MutationObserver(() => {
      scheduleScan();
    });

    if (document.documentElement) {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    }

    port.onDisconnect.addListener(() => {
      observer.disconnect();
      detachPlayer();
      clearPendingRemotePlayback();
      clearScanBurst();
      expectedRemoteEcho = undefined;
      if (pageKeyPollIntervalId) {
        window.clearInterval(pageKeyPollIntervalId);
      }
      if (fallbackScanIntervalId) {
        window.clearInterval(fallbackScanIntervalId);
      }
      if (heartbeatIntervalId) {
        window.clearInterval(heartbeatIntervalId);
      }
      history.pushState = originalPushState as History["pushState"];
      history.replaceState = originalReplaceState as History["replaceState"];
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("pageshow", handlePopState);
    });

    port.onMessage.addListener((message) => {
      if (message.type === "background:apply-remote") {
        applyRemotePlayback(message);
      }
    });

    scanForPlayer();
    if (!player) {
      scheduleScanBurst();
    }
  },
});
