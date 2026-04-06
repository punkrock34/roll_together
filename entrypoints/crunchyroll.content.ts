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

export default defineContentScript({
  matches: ["*://crunchyroll.com/*", "*://*.crunchyroll.com/*"],
  allFrames: true,
  runAt: "document_idle",
  main() {
    const FAST_SCAN_DELAYS_MS = [0, 50, 125, 250, 500, 900, 1_400];
    const FALLBACK_SCAN_INTERVAL_MS = 2_000;
    const PAGE_KEY_POLL_INTERVAL_MS = 1_000;
    const port = browser.runtime.connect({ name: CONTENT_PORT_NAME });

    let player: HTMLVideoElement | null = null;
    let disposePlayerListeners: (() => void) | undefined;
    let ignoreLocalEventsUntil = 0;
    let lastBroadcastAt = 0;
    let scanQueued = false;
    let scanBurstTimeoutIds: number[] = [];
    let lastPageKey = `${window.location.href}|${document.title}`;

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

    const postSnapshot = (reason: ContentSnapshotReason) => {
      const snapshot = buildSnapshot();
      if (!snapshot) {
        return;
      }

      const message: ContentOutboundMessage = {
        type: "content:snapshot",
        tabUrl: window.location.href,
        episode: extractEpisodeInfo(window.location.href, document.title),
        playback: snapshot,
        roomIdFromUrl: getRoomIdFromUrl(window.location.href),
        reason,
      };

      port.postMessage(message);
      lastBroadcastAt = Date.now();
    };

    const handleLocalChange = () => {
      if (Date.now() < ignoreLocalEventsUntil) {
        return;
      }

      postSnapshot("interaction");
    };

    const applyRemotePlayback = (message: ApplyRemotePlaybackMessage) => {
      const snapshot = buildSnapshot();
      if (!player || !snapshot) {
        return;
      }

      const decision = buildSyncDecision(snapshot, message.playback);
      ignoreLocalEventsUntil = Date.now() + 500;

      if (decision.shouldSeek) {
        player.currentTime = decision.targetTime;
      }

      if (decision.shouldPause) {
        player.pause();
      }

      if (decision.shouldPlay) {
        void player.play().catch(() => undefined);
      }
    };

    const detachPlayer = () => {
      disposePlayerListeners?.();
      disposePlayerListeners = undefined;
      player = null;
    };

    const attachPlayer = (candidate: HTMLVideoElement) => {
      if (player === candidate) {
        return;
      }

      detachPlayer();
      clearScanBurst();
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

      const handleTimeUpdate = () => {
        if (Date.now() - lastBroadcastAt >= 1_250) {
          postSnapshot("heartbeat");
        }
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
    }, 10_000);

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
      clearScanBurst();
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
