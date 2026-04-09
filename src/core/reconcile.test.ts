import { describe, expect, it, vi } from "vitest";

import {
  buildSyncDecision,
  needsPlaybackCorrection,
  shouldAcceptRoomPlaybackUpdate,
} from "./reconcile";
import type { PlaybackSnapshot } from "./protocol";

const basePlayback: PlaybackSnapshot = {
  provider: "crunchyroll",
  episodeId: "example",
  episodeUrl: "https://www.crunchyroll.com/watch/example",
  episodeTitle: "Example Episode",
  state: "paused",
  currentTime: 12,
  duration: 120,
  playbackRate: 1,
  updatedAt: 1,
};

describe("buildSyncDecision", () => {
  it("requests play when the remote room is playing", () => {
    const decision = buildSyncDecision(basePlayback, {
      ...basePlayback,
      state: "playing",
    });

    expect(decision.shouldPlay).toBe(true);
    expect(decision.shouldPause).toBe(false);
  });

  it("requests a seek when drift exceeds the threshold", () => {
    const decision = buildSyncDecision(basePlayback, {
      ...basePlayback,
      currentTime: 20,
    });

    expect(decision.shouldSeek).toBe(true);
    expect(decision.targetTime).toBe(20);
  });

  it("ignores tiny drift", () => {
    const decision = buildSyncDecision(basePlayback, {
      ...basePlayback,
      currentTime: 12.4,
    });

    expect(decision.shouldSeek).toBe(false);
  });

  it("waits until drift is meaningfully large before seeking", () => {
    const decision = buildSyncDecision(basePlayback, {
      ...basePlayback,
      currentTime: 14.8,
    });

    expect(decision.shouldSeek).toBe(false);
  });

  it("supports a stricter drift threshold for catch-up cases", () => {
    const decision = buildSyncDecision(
      basePlayback,
      {
        ...basePlayback,
        currentTime: 13.4,
      },
      1,
    );

    expect(decision.shouldSeek).toBe(true);
  });

  it("projects remote playing time using updatedAt before deciding seek", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(8_000);
    const decision = buildSyncDecision(
      {
        ...basePlayback,
        state: "playing",
        currentTime: 12,
        updatedAt: 8_000,
      },
      {
        ...basePlayback,
        state: "playing",
        currentTime: 8,
        updatedAt: 4_000,
      },
      1,
    );
    nowSpy.mockRestore();

    expect(decision.shouldSeek).toBe(false);
    expect(decision.targetTime).toBe(12);
  });

  it("still seeks when projected remote drift remains above threshold", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(8_000);
    const decision = buildSyncDecision(
      {
        ...basePlayback,
        state: "playing",
        currentTime: 12,
        updatedAt: 8_000,
      },
      {
        ...basePlayback,
        state: "playing",
        currentTime: 8,
        updatedAt: 7_500,
      },
      1,
    );
    nowSpy.mockRestore();

    expect(decision.shouldSeek).toBe(true);
    expect(decision.targetTime).toBe(8.5);
  });

  it("skips corrections when playback is already close enough", () => {
    expect(
      needsPlaybackCorrection(basePlayback, {
        ...basePlayback,
        currentTime: 13.5,
      }),
    ).toBe(false);
  });

  it("requests a seek when the remote room switches episodes", () => {
    const decision = buildSyncDecision(basePlayback, {
      ...basePlayback,
      episodeId: "example-2",
      episodeUrl: "https://www.crunchyroll.com/watch/example-2",
      episodeTitle: "Example Episode 2",
      currentTime: 0,
    });

    expect(decision.shouldSeek).toBe(true);
    expect(decision.targetTime).toBe(0);
  });
});

describe("shouldAcceptRoomPlaybackUpdate", () => {
  it("accepts playback when no room playback is known yet", () => {
    expect(shouldAcceptRoomPlaybackUpdate(undefined, basePlayback)).toBe(true);
  });

  it("accepts a newer same-episode sync", () => {
    expect(
      shouldAcceptRoomPlaybackUpdate(basePlayback, {
        ...basePlayback,
        currentTime: 24,
        updatedAt: 2,
      }),
    ).toBe(true);
  });

  it("rejects an older same-episode sync", () => {
    expect(
      shouldAcceptRoomPlaybackUpdate(
        {
          ...basePlayback,
          currentTime: 24,
          updatedAt: 3,
        },
        {
          ...basePlayback,
          currentTime: 18,
          updatedAt: 2,
        },
      ),
    ).toBe(false);
  });

  it("rejects an older cross-episode navigate", () => {
    expect(
      shouldAcceptRoomPlaybackUpdate(
        {
          ...basePlayback,
          episodeId: "example-2",
          episodeUrl: "https://www.crunchyroll.com/watch/example-2",
          episodeTitle: "Example Episode 2",
          updatedAt: 10,
        },
        {
          ...basePlayback,
          updatedAt: 9,
        },
      ),
    ).toBe(false);
  });

  it("accepts a newer cross-episode navigate", () => {
    expect(
      shouldAcceptRoomPlaybackUpdate(basePlayback, {
        ...basePlayback,
        episodeId: "example-2",
        episodeUrl: "https://www.crunchyroll.com/watch/example-2",
        episodeTitle: "Example Episode 2",
        updatedAt: 10,
      }),
    ).toBe(true);
  });
});
