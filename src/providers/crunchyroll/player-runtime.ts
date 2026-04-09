import type { PlayerRuntimeState } from "../../core/messages";

export function buildPlayerRuntimeState(
  player: HTMLVideoElement,
  episodeId: string,
  updatedAt = Date.now(),
): PlayerRuntimeState {
  return {
    paused: player.paused,
    currentTime: player.currentTime,
    duration: Number.isFinite(player.duration) ? player.duration : null,
    playbackRate: player.playbackRate,
    readyState: player.readyState,
    seeking: player.seeking,
    ended: player.ended,
    episodeId,
    updatedAt,
  };
}
