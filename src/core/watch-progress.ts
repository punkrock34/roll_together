import type { PlaybackSnapshot } from "./protocol";
import type { WatchProgressEntry } from "./storage";

export function isCompleted(
  progressSeconds: number,
  duration: number | null,
): boolean {
  if (duration === null || duration <= 0) {
    return false;
  }

  return progressSeconds / duration >= 0.9;
}

export function toWatchProgressEntry(
  playback: PlaybackSnapshot,
): WatchProgressEntry {
  return {
    episodeUrl: playback.episodeUrl,
    episodeTitle: playback.episodeTitle,
    provider: playback.provider,
    progressSeconds: Math.max(0, Math.floor(playback.currentTime)),
    durationSeconds:
      playback.duration === null
        ? null
        : Math.max(0, Math.floor(playback.duration)),
    updatedAt: playback.updatedAt,
    completed: isCompleted(playback.currentTime, playback.duration),
  };
}
