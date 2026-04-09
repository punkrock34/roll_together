import type { ContentSnapshotReason } from "../../core/messages";

export function detectLargeTimeDiscontinuity(
  previousTime: number | undefined,
  nextTime: number,
  thresholdSeconds: number,
) {
  if (previousTime === undefined) {
    return false;
  }

  return Math.abs(nextTime - previousTime) > thresholdSeconds;
}

export function mapReasonToPlaybackCommand(
  reason: ContentSnapshotReason,
): "play" | "pause" | "seek" | undefined {
  if (reason === "play") {
    return "play";
  }
  if (reason === "pause") {
    return "pause";
  }
  if (reason === "seeked") {
    return "seek";
  }
  return undefined;
}
