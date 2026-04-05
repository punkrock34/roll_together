import { describe, expect, it } from "vitest";

import type { PlaybackSnapshot } from "../../core/protocol";

import {
  normalizePlaybackSnapshotForTab,
  resolveRoomIdForTabContext,
} from "./session";

const playback: PlaybackSnapshot = {
  provider: "crunchyroll",
  episodeUrl: "https://static.crunchyroll.com/vilos-v2/web/vilos/player.html",
  episodeTitle: "Vilos",
  state: "playing",
  currentTime: 31,
  duration: 1400,
  playbackRate: 1,
  updatedAt: 123,
};

describe("Crunchyroll tab context helpers", () => {
  it("normalizes playback metadata against the top-level tab", () => {
    expect(
      normalizePlaybackSnapshotForTab(
        playback,
        "https://crunchyroll.com/watch/G14U43XM9/brave-volunteers?rollTogetherRoom=room-1",
        "Attack on Titan E68 - Brave Volunteers | Crunchyroll",
      ),
    ).toMatchObject({
      provider: "crunchyroll",
      episodeUrl: "https://crunchyroll.com/watch/G14U43XM9/brave-volunteers",
      episodeTitle: "Attack on Titan E68 - Brave Volunteers",
      currentTime: 31,
    });
  });

  it("prefers the top-level tab room id over a missing frame query", () => {
    expect(
      resolveRoomIdForTabContext(
        "https://crunchyroll.com/watch/G14U43XM9/brave-volunteers?rollTogetherRoom=room-2",
      ),
    ).toBe("room-2");
  });

  it("falls back to a previously supplied room id when needed", () => {
    expect(resolveRoomIdForTabContext(undefined, "room-3")).toBe("room-3");
  });
});
