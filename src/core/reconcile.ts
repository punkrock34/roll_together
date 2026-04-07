import type { PlaybackSnapshot } from "./protocol";

export const SYNC_DRIFT_THRESHOLD_SECONDS = 3;

export interface SyncDecision {
  shouldPlay: boolean;
  shouldPause: boolean;
  shouldSeek: boolean;
  targetTime: number;
}

export function buildSyncDecision(
  local: PlaybackSnapshot,
  remote: PlaybackSnapshot,
  driftThresholdSeconds = SYNC_DRIFT_THRESHOLD_SECONDS,
): SyncDecision {
  const shouldSeek =
    local.episodeUrl !== remote.episodeUrl ||
    Math.abs(remote.currentTime - local.currentTime) > driftThresholdSeconds;

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

export function shouldAcceptRoomPlaybackUpdate(
  current: PlaybackSnapshot | undefined,
  next: PlaybackSnapshot,
) {
  if (!current) {
    return true;
  }

  return next.updatedAt >= current.updatedAt;
}

export function needsPlaybackCorrection(
  local: PlaybackSnapshot | undefined,
  remote: PlaybackSnapshot | undefined,
  driftThresholdSeconds = SYNC_DRIFT_THRESHOLD_SECONDS,
) {
  if (!local || !remote) {
    return true;
  }

  const decision = buildSyncDecision(local, remote, driftThresholdSeconds);
  return decision.shouldPlay || decision.shouldPause || decision.shouldSeek;
}
