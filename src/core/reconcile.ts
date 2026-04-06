import type { PlaybackSnapshot } from "./protocol";

export const SYNC_DRIFT_THRESHOLD_SECONDS = 0.75;

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
    local.episodeUrl !== remote.episodeUrl ||
    Math.abs(remote.currentTime - local.currentTime) >
      SYNC_DRIFT_THRESHOLD_SECONDS;

  return {
    shouldPlay: local.state !== remote.state && remote.state === "playing",
    shouldPause: local.state !== remote.state && remote.state === "paused",
    shouldSeek,
    targetTime: remote.currentTime,
  };
}

export function arePlaybackSnapshotsSimilar(
  left: PlaybackSnapshot | undefined,
  right: PlaybackSnapshot | undefined,
  driftThresholdSeconds = 0.35,
) {
  if (!left || !right) {
    return false;
  }

  return (
    left.episodeUrl === right.episodeUrl &&
    left.state === right.state &&
    left.playbackRate === right.playbackRate &&
    left.duration === right.duration &&
    Math.abs(left.currentTime - right.currentTime) <= driftThresholdSeconds
  );
}
