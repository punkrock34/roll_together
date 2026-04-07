import type { ParticipantPresence, PlaybackSnapshot } from "./protocol";
import { needsPlaybackCorrection } from "./reconcile";

export function canTransferHostToParticipant(
  localSessionId: string | undefined,
  isLocalHost: boolean,
  participant: ParticipantPresence,
) {
  if (!isLocalHost) {
    return false;
  }

  if (!participant.connected || participant.isHost) {
    return false;
  }

  return participant.sessionId !== localSessionId;
}

export function shouldWaitForHostTakeoverAlignment(
  localPlayback: PlaybackSnapshot | undefined,
  canonicalPlayback: PlaybackSnapshot,
) {
  return needsPlaybackCorrection(localPlayback, canonicalPlayback);
}

export function consumePendingHostTakeoverPlayback(
  pendingPlayback: PlaybackSnapshot | undefined,
  localPlayback: PlaybackSnapshot,
) {
  if (!pendingPlayback) {
    return {
      blocked: false,
      pendingPlayback: undefined,
    };
  }

  if (needsPlaybackCorrection(localPlayback, pendingPlayback)) {
    return {
      blocked: true,
      pendingPlayback,
    };
  }

  return {
    blocked: true,
    pendingPlayback: undefined,
  };
}
