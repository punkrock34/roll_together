import { describe, expect, it } from "vitest";

import {
  detectLargeTimeDiscontinuity,
  mapReasonToPlaybackCommand,
} from "./content-sync";

describe("Crunchyroll content sync helpers", () => {
  it("flags only large time discontinuities", () => {
    expect(detectLargeTimeDiscontinuity(undefined, 12, 3)).toBe(false);
    expect(detectLargeTimeDiscontinuity(10, 12.2, 3)).toBe(false);
    expect(detectLargeTimeDiscontinuity(10, 14.5, 3)).toBe(true);
  });

  it("maps only meaningful transition reasons to playback commands", () => {
    expect(mapReasonToPlaybackCommand("play")).toBe("play");
    expect(mapReasonToPlaybackCommand("pause")).toBe("pause");
    expect(mapReasonToPlaybackCommand("seeked")).toBe("seek");
    expect(mapReasonToPlaybackCommand("discontinuity")).toBeUndefined();
    expect(mapReasonToPlaybackCommand("heartbeat")).toBeUndefined();
    expect(mapReasonToPlaybackCommand("initial")).toBeUndefined();
    expect(mapReasonToPlaybackCommand("remote-apply")).toBeUndefined();
  });
});
