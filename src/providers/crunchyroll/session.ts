import type { PlaybackSnapshot } from "../../core/protocol";
import { getRoomIdFromUrl } from "../../core/url";

import { extractEpisodeInfo, isCrunchyrollUrl } from "./player";

export function normalizePlaybackSnapshotForTab(
  playback: PlaybackSnapshot,
  tabUrl?: string,
  tabTitle?: string,
): PlaybackSnapshot {
  if (!tabUrl || !isCrunchyrollUrl(tabUrl)) {
    return playback;
  }

  const episode = extractEpisodeInfo(
    tabUrl,
    typeof tabTitle === "string" && tabTitle.trim().length > 0
      ? tabTitle
      : playback.episodeTitle,
  );

  return {
    ...playback,
    ...episode,
  };
}

export function resolveRoomIdForTabContext(
  tabUrl: string | undefined,
  fallbackRoomId?: string | null,
): string | null {
  return (tabUrl ? getRoomIdFromUrl(tabUrl) : null) ?? fallbackRoomId ?? null;
}

export function didEpisodeChange(
  previousPlayback: PlaybackSnapshot | undefined,
  nextPlayback: PlaybackSnapshot,
) {
  return previousPlayback?.episodeUrl !== nextPlayback.episodeUrl;
}
