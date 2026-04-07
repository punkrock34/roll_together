import type { PlaybackSnapshot } from "../../core/protocol";
import type { SyncDecision } from "../../core/reconcile";

const REMOTE_ECHO_EXPIRY_MS = 1_500;
const REMOTE_ECHO_TIME_TOLERANCE_SECONDS = 1;

export interface RemoteEchoExpectation {
  playback: PlaybackSnapshot;
  shouldPlay: boolean;
  shouldPause: boolean;
  shouldSeek: boolean;
  expiresAt: number;
}

interface RemoteEchoConsumption {
  shouldSuppress: boolean;
  nextExpectation?: RemoteEchoExpectation;
}

export function createRemoteEchoExpectation(
  playback: PlaybackSnapshot,
  decision: SyncDecision,
  now = Date.now(),
): RemoteEchoExpectation | undefined {
  if (!decision.shouldPlay && !decision.shouldPause && !decision.shouldSeek) {
    return undefined;
  }

  return {
    playback,
    shouldPlay: decision.shouldPlay,
    shouldPause: decision.shouldPause,
    shouldSeek: decision.shouldSeek,
    expiresAt: now + REMOTE_ECHO_EXPIRY_MS,
  };
}

export function consumeRemoteEchoExpectation(
  expectation: RemoteEchoExpectation | undefined,
  playback: PlaybackSnapshot,
  now = Date.now(),
): RemoteEchoConsumption {
  if (!expectation) {
    return { shouldSuppress: false };
  }

  if (now > expectation.expiresAt) {
    return { shouldSuppress: false };
  }

  if (playback.episodeUrl !== expectation.playback.episodeUrl) {
    return {
      shouldSuppress: false,
      nextExpectation: expectation,
    };
  }

  const matchedSeek =
    expectation.shouldSeek &&
    Math.abs(playback.currentTime - expectation.playback.currentTime) <=
      REMOTE_ECHO_TIME_TOLERANCE_SECONDS;
  const matchedPlay =
    expectation.shouldPlay &&
    playback.state === "playing" &&
    Math.abs(playback.currentTime - expectation.playback.currentTime) <=
      REMOTE_ECHO_TIME_TOLERANCE_SECONDS;
  const matchedPause =
    expectation.shouldPause &&
    playback.state === "paused" &&
    Math.abs(playback.currentTime - expectation.playback.currentTime) <=
      REMOTE_ECHO_TIME_TOLERANCE_SECONDS;

  if (!matchedSeek && !matchedPlay && !matchedPause) {
    return {
      shouldSuppress: false,
      nextExpectation: expectation,
    };
  }

  const nextExpectation: RemoteEchoExpectation = {
    ...expectation,
    shouldSeek: expectation.shouldSeek && !matchedSeek,
    shouldPlay: expectation.shouldPlay && !matchedPlay,
    shouldPause: expectation.shouldPause && !matchedPause,
    expiresAt: now + REMOTE_ECHO_EXPIRY_MS,
  };

  if (
    !nextExpectation.shouldSeek &&
    !nextExpectation.shouldPlay &&
    !nextExpectation.shouldPause
  ) {
    return { shouldSuppress: true };
  }

  return {
    shouldSuppress: true,
    nextExpectation,
  };
}
