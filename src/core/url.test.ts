import { describe, expect, it } from "vitest";

import {
  buildRoomInviteUrl,
  getRoomIdFromUrl,
  stripRoomIdFromUrl,
} from "./url";

describe("room url helpers", () => {
  it("extracts a room id from the page url", () => {
    expect(
      getRoomIdFromUrl(
        "https://www.crunchyroll.com/watch/GQJUGQ29Z/episode-title?rollTogetherRoom=abc123",
      ),
    ).toBe("abc123");
  });

  it("replaces an existing room id when building share links", () => {
    expect(
      buildRoomInviteUrl(
        "https://www.crunchyroll.com/watch/GQJUGQ29Z/example?rollTogetherRoom=old",
        "new-room",
      ),
    ).toContain("rollTogetherRoom=new-room");
  });

  it("strips the room id without affecting the episode url", () => {
    expect(
      stripRoomIdFromUrl(
        "https://www.crunchyroll.com/watch/GQJUGQ29Z/example?rollTogetherRoom=old",
      ),
    ).toBe("https://www.crunchyroll.com/watch/GQJUGQ29Z/example");
  });
});
