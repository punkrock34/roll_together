import type { PlaybackSnapshot } from "./protocol";

export const SYNC_DRIFT_THRESHOLD_SECONDS = 1.25;

export interface SyncDecision {
  shouldPlay: boolean;
  shouldPause: boolean;
  shouldSeek: boolean;
  targetTime: number;
}

export function buildSyncDecision(
  local: PlaybackSnapshot,
  remote: PlaybackSnapshot,
): SyncDecision {
  const shouldSeek =
    Math.abs(remote.currentTime - local.currentTime) >
    SYNC_DRIFT_THRESHOLD_SECONDS;

  return {
    shouldPlay: local.state !== remote.state && remote.state === "playing",
    shouldPause: local.state !== remote.state && remote.state === "paused",
    shouldSeek,
    targetTime: remote.currentTime,
  };
}
