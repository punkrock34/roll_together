import { browser } from "wxt/browser";

import {
  CONTENT_PORT_NAME,
  type ApplyRemotePlaybackMessage,
  type ContentOutboundMessage,
} from "../src/core/messages";
import type { PlaybackSnapshot } from "../src/core/protocol";
import { buildSyncDecision } from "../src/core/reconcile";
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
    const port = browser.runtime.connect({ name: CONTENT_PORT_NAME });

    let player: HTMLVideoElement | null = null;
    let disposePlayerListeners: (() => void) | undefined;
    let ignoreLocalEventsUntil = 0;
    let lastBroadcastAt = 0;
    let scanQueued = false;

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

    const postSnapshot = () => {
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
      };

      port.postMessage(message);
    };

    const handleLocalChange = () => {
      if (Date.now() < ignoreLocalEventsUntil) {
        return;
      }

      lastBroadcastAt = Date.now();
      postSnapshot();
    };

    const applyRemotePlayback = (message: ApplyRemotePlaybackMessage) => {
      const snapshot = buildSnapshot();
      if (!player || !snapshot) {
        return;
      }

      const decision = buildSyncDecision(snapshot, message.playback);
      ignoreLocalEventsUntil = Date.now() + 800;

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
        if (Date.now() - lastBroadcastAt >= 2000) {
          handleLocalChange();
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

      postSnapshot();
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

    const scheduleScan = () => {
      if (scanQueued) {
        return;
      }

      scanQueued = true;
      window.setTimeout(() => {
        scanQueued = false;
        scanForPlayer();
      }, 0);
    };

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
    });

    port.onMessage.addListener((message) => {
      if (message.type === "background:apply-remote") {
        applyRemotePlayback(message);
      }
    });

    window.setInterval(scanForPlayer, 750);
    window.setInterval(postSnapshot, 15_000);
    scanForPlayer();
  },
});
