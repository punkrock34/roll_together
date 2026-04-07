import type { PlaybackSnapshot } from "./protocol";
import { needsPlaybackCorrection } from "./reconcile";

export const FOLLOWER_CATCHUP_DRIFT_THRESHOLD_SECONDS = 1;

export function shouldStartFollowerCatchup(
  localPlayback: PlaybackSnapshot | undefined,
  canonicalPlayback: PlaybackSnapshot,
) {
  return (
    canonicalPlayback.state === "playing" &&
    needsPlaybackCorrection(
      localPlayback,
      canonicalPlayback,
      FOLLOWER_CATCHUP_DRIFT_THRESHOLD_SECONDS,
    )
  );
}
