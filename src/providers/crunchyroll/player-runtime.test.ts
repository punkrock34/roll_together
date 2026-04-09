import { describe, expect, it } from "vitest";

import { buildPlayerRuntimeState } from "./player-runtime";

describe("buildPlayerRuntimeState", () => {
  it("captures explicit runtime fields used by bounded verification", () => {
    const video = document.createElement("video");
    Object.defineProperty(video, "paused", { configurable: true, value: false });
    Object.defineProperty(video, "currentTime", { configurable: true, value: 12.5 });
    Object.defineProperty(video, "duration", { configurable: true, value: 24 });
    Object.defineProperty(video, "playbackRate", { configurable: true, value: 1 });
    Object.defineProperty(video, "readyState", { configurable: true, value: 3 });
    Object.defineProperty(video, "seeking", { configurable: true, value: true });
    Object.defineProperty(video, "ended", { configurable: true, value: false });

    const state = buildPlayerRuntimeState(video, "G4VUQ1ZKW", 1234);

    expect(state).toEqual({
      paused: false,
      currentTime: 12.5,
      duration: 24,
      playbackRate: 1,
      readyState: 3,
      seeking: true,
      ended: false,
      episodeId: "G4VUQ1ZKW",
      updatedAt: 1234,
    });
  });
});
