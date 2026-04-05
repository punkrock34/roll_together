import { describe, expect, it } from "vitest";

import { buildSyncDecision } from "./reconcile";
import type { PlaybackSnapshot } from "./protocol";

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
});
