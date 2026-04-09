import type { PlaybackState, EpisodeInfo } from "../core/protocol";

export interface PlayerAdapterRuntimeSample {
  paused: boolean;
  currentTime: number;
  duration: number | null;
  playbackRate: number;
  readyState: number;
  seeking: boolean;
  ended: boolean;
}

export interface PlayerAdapterEventHandlers {
  onPlayerChanged?: (ready: boolean) => void;
  onPlay?: () => void;
  onPause?: () => void;
  onSeeked?: () => void;
  onTimeUpdate?: (currentTime: number) => void;
  onPlaying?: () => void;
  onCanPlay?: () => void;
  onLoadedData?: () => void;
}

export interface PlayerAdapter {
  getPlaybackState(): PlaybackState;
  getCurrentTime(): number;
  getDuration(): number | null;
  play(): Promise<boolean>;
  pause(): void;
  seekTo(seconds: number): { method: string; targetTime: number };
  getMediaIdentity(): EpisodeInfo;
  isReady(): boolean;
  isSeeking(): boolean;
  isInAd(): boolean;
  attachListeners(handlers: PlayerAdapterEventHandlers): () => void;
  cleanup(): void;
  getRuntimeSample(): PlayerAdapterRuntimeSample | null;
}
