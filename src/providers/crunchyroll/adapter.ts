import type {
  PlayerAdapter,
  PlayerAdapterEventHandlers,
  PlayerAdapterRuntimeSample,
} from "../player-adapter";

import {
  extractEpisodeInfo,
  findCrunchyrollPlayer,
  seekCrunchyrollPlayer,
  type CrunchyrollSeekResult,
} from "./player";

const FAST_SCAN_DELAYS_MS = [0, 50, 125, 250, 500, 900, 1_400];
const FALLBACK_SCAN_INTERVAL_MS = 2_000;

function isAdVisible(doc: Document): boolean {
  const selectors = [
    '[data-testid*="ad-countdown"]',
    '[data-testid*="ad-break"]',
    ".ad-countdown",
    ".ad-break",
  ];

  return selectors.some((selector) => doc.querySelector(selector) !== null);
}

export class CrunchyrollPlayerAdapter implements PlayerAdapter {
  private player: HTMLVideoElement | null = null;
  private disposePlayerListeners: (() => void) | undefined;
  private handlers: PlayerAdapterEventHandlers | undefined;
  private fallbackScanIntervalId: number | undefined;
  private mutationObserver: MutationObserver | undefined;
  private scanQueued = false;
  private scanBurstTimeoutIds: number[] = [];

  getPlaybackState(): "playing" | "paused" {
    const player = this.ensurePlayer();
    if (!player || player.paused) {
      return "paused";
    }

    return "playing";
  }

  getCurrentTime(): number {
    return this.ensurePlayer()?.currentTime ?? 0;
  }

  getDuration(): number | null {
    const duration = this.ensurePlayer()?.duration;
    if (!Number.isFinite(duration)) {
      return null;
    }

    return duration ?? null;
  }

  async play(): Promise<boolean> {
    const player = this.ensurePlayer();
    if (!player) {
      return false;
    }

    try {
      await player.play();
      return true;
    } catch {
      return false;
    }
  }

  pause(): void {
    this.ensurePlayer()?.pause();
  }

  seekTo(seconds: number): CrunchyrollSeekResult {
    const player = this.ensurePlayer();
    const targetTime = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;

    if (!player) {
      return {
        method: "currentTime",
        targetTime,
      };
    }

    return seekCrunchyrollPlayer(player, targetTime);
  }

  getMediaIdentity() {
    return extractEpisodeInfo(window.location.href, document.title);
  }

  isReady(): boolean {
    const player = this.ensurePlayer();
    return Boolean(player && player.readyState > 0);
  }

  isSeeking(): boolean {
    return this.ensurePlayer()?.seeking ?? false;
  }

  isInAd(): boolean {
    return isAdVisible(document);
  }

  getRuntimeSample(): PlayerAdapterRuntimeSample | null {
    const player = this.ensurePlayer();
    if (!player) {
      return null;
    }

    return {
      paused: player.paused,
      currentTime: player.currentTime,
      duration: Number.isFinite(player.duration) ? player.duration : null,
      playbackRate: player.playbackRate,
      readyState: player.readyState,
      seeking: player.seeking,
      ended: player.ended,
    };
  }

  attachListeners(handlers: PlayerAdapterEventHandlers): () => void {
    this.cleanup();
    this.handlers = handlers;

    this.observeDom();
    this.scheduleScanBurst();
    this.fallbackScanIntervalId = window.setInterval(() => {
      if (!this.player || !this.player.isConnected) {
        this.scheduleScan();
      }
    }, FALLBACK_SCAN_INTERVAL_MS);

    return () => {
      this.cleanup();
    };
  }

  requestScanBurst(): void {
    this.scheduleScanBurst();
  }

  cleanup(): void {
    this.clearScanBurst();

    if (this.fallbackScanIntervalId !== undefined) {
      window.clearInterval(this.fallbackScanIntervalId);
      this.fallbackScanIntervalId = undefined;
    }

    this.scanQueued = false;
    this.mutationObserver?.disconnect();
    this.mutationObserver = undefined;

    this.detachPlayer(false);
    this.handlers = undefined;
  }

  private ensurePlayer(): HTMLVideoElement | null {
    if (this.player?.isConnected) {
      return this.player;
    }

    this.scanForPlayer();
    return this.player;
  }

  private observeDom() {
    if (this.mutationObserver) {
      return;
    }

    const root = document.documentElement;
    if (!root) {
      return;
    }

    this.mutationObserver = new MutationObserver(() => {
      this.scheduleScan();
    });

    this.mutationObserver.observe(root, {
      childList: true,
      subtree: true,
    });
  }

  private scanForPlayer() {
    const previousPlayer = this.player;
    const candidate = findCrunchyrollPlayer(document);

    if (candidate && candidate !== previousPlayer) {
      this.attachPlayer(candidate);
      return;
    }

    if (!candidate && previousPlayer && !previousPlayer.isConnected) {
      this.detachPlayer(true);
    }
  }

  private scheduleScan() {
    if (this.scanQueued) {
      return;
    }

    this.scanQueued = true;
    window.setTimeout(() => {
      this.scanQueued = false;
      this.scanForPlayer();
      if (!this.player) {
        this.scheduleScanBurst();
      }
    }, 0);
  }

  private scheduleScanBurst() {
    this.clearScanBurst();

    for (const delayMs of FAST_SCAN_DELAYS_MS) {
      const timeoutId = window.setTimeout(() => {
        this.scanForPlayer();
        if (this.player) {
          this.clearScanBurst();
        }
      }, delayMs);

      this.scanBurstTimeoutIds.push(timeoutId);
    }
  }

  private clearScanBurst() {
    for (const timeoutId of this.scanBurstTimeoutIds) {
      window.clearTimeout(timeoutId);
    }

    this.scanBurstTimeoutIds = [];
  }

  private attachPlayer(candidate: HTMLVideoElement) {
    this.detachPlayer(false);

    this.player = candidate;
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

    addListener("play", () => {
      this.handlers?.onPlay?.();
    });
    addListener("pause", () => {
      this.handlers?.onPause?.();
    });
    addListener("seeked", () => {
      this.handlers?.onSeeked?.();
    });
    addListener("timeupdate", () => {
      this.handlers?.onTimeUpdate?.(candidate.currentTime);
    });
    addListener("playing", () => {
      this.handlers?.onPlaying?.();
    });
    addListener("canplay", () => {
      this.handlers?.onCanPlay?.();
    });
    addListener("loadeddata", () => {
      this.handlers?.onLoadedData?.();
    });

    this.disposePlayerListeners = () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };

    this.handlers?.onPlayerChanged?.(true);
  }

  private detachPlayer(notify: boolean) {
    this.disposePlayerListeners?.();
    this.disposePlayerListeners = undefined;

    const hadPlayer = Boolean(this.player);
    this.player = null;

    if (notify && hadPlayer) {
      this.handlers?.onPlayerChanged?.(false);
    }
  }
}

export function createCrunchyrollPlayerAdapter(): CrunchyrollPlayerAdapter {
  return new CrunchyrollPlayerAdapter();
}
