import { describe, expect, it } from "vitest";

import type { ParticipantPresence, PlaybackSnapshot } from "./protocol";
import {
  canTransferHostToParticipant,
  consumePendingHostTakeoverPlayback,
  shouldWaitForHostTakeoverAlignment,
} from "./host-transfer";

const basePlayback: PlaybackSnapshot = {
  provider: "crunchyroll",
  episodeUrl: "https://www.crunchyroll.com/watch/example",
  episodeTitle: "Example Episode",
  state: "paused",
  currentTime: 12,
  duration: 120,
  playbackRate: 1,
  updatedAt: 1,
};

const viewer: ParticipantPresence = {
  sessionId: "viewer-1",
  displayName: "Viewer",
  isHost: false,
  joinedAt: 1,
  lastSeenAt: 1,
  connected: true,
};

describe("host transfer helpers", () => {
  it("only allows transfer to connected followers when the local user is host", () => {
    expect(canTransferHostToParticipant("host-1", true, viewer)).toBe(true);
    expect(
      canTransferHostToParticipant("host-1", false, {
        ...viewer,
      }),
    ).toBe(false);
    expect(
      canTransferHostToParticipant("host-1", true, {
        ...viewer,
        sessionId: "host-1",
      }),
    ).toBe(false);
    expect(
      canTransferHostToParticipant("host-1", true, {
        ...viewer,
        connected: false,
      }),
    ).toBe(false);
  });

  it("detects when a promoted host still needs canonical playback applied", () => {
    expect(
      shouldWaitForHostTakeoverAlignment(basePlayback, {
        ...basePlayback,
        currentTime: 30,
      }),
    ).toBe(true);

    expect(
      shouldWaitForHostTakeoverAlignment(basePlayback, {
        ...basePlayback,
      }),
    ).toBe(false);
  });

  it("blocks host outbound sync until the promoted host is aligned", () => {
    const pending = { ...basePlayback, currentTime: 40 };

    expect(consumePendingHostTakeoverPlayback(pending, basePlayback)).toEqual({
      blocked: true,
      pendingPlayback: pending,
    });

    expect(
      consumePendingHostTakeoverPlayback(pending, {
        ...basePlayback,
        currentTime: 40,
      }),
    ).toEqual({
      blocked: true,
      pendingPlayback: undefined,
    });

    expect(consumePendingHostTakeoverPlayback(undefined, basePlayback)).toEqual(
      {
        blocked: false,
        pendingPlayback: undefined,
      },
    );
  });
});
