import { describe, expect, it } from "vitest";

import type { PlaybackSnapshot } from "./protocol";
import {
  FOLLOWER_CATCHUP_DRIFT_THRESHOLD_SECONDS,
  shouldStartFollowerCatchup,
} from "./follower-catchup";

const basePlayback: PlaybackSnapshot = {
  provider: "crunchyroll",
  episodeUrl: "https://www.crunchyroll.com/watch/example",
  episodeTitle: "Example Episode",
  state: "playing",
  currentTime: 12,
  duration: 120,
  playbackRate: 1,
  updatedAt: 1,
};

describe("follower catch-up helpers", () => {
  it("waits for alignment when a follower joins more than one second behind", () => {
    expect(
      shouldStartFollowerCatchup(basePlayback, {
        ...basePlayback,
        currentTime:
          basePlayback.currentTime +
          FOLLOWER_CATCHUP_DRIFT_THRESHOLD_SECONDS +
          0.2,
      }),
    ).toBe(true);
  });

  it("does not start catch-up for paused playback", () => {
    expect(
      shouldStartFollowerCatchup(
        {
          ...basePlayback,
          state: "paused",
          currentTime: 12,
        },
        {
          ...basePlayback,
          state: "paused",
          currentTime: 18,
        },
      ),
    ).toBe(false);
  });

  it("does not start catch-up when playback is already close enough", () => {
    expect(
      shouldStartFollowerCatchup(basePlayback, {
        ...basePlayback,
        currentTime: 12.8,
      }),
    ).toBe(false);
  });
});
