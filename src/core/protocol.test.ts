import { describe, expect, it } from "vitest";

import { PROTOCOL_VERSION, parseServerMessage } from "./protocol";

describe("extension protocol", () => {
  it("parses a valid host_transferred server message", () => {
    const message = parseServerMessage(
      JSON.stringify({
        type: "host_transferred",
        version: PROTOCOL_VERSION,
        roomId: "room-1",
        participantCount: 2,
        participants: [],
        hostSessionId: "viewer-1",
        previousHostSessionId: "host-1",
        playback: {
          provider: "crunchyroll",
          episodeTitle: "Episode 1",
          episodeUrl: "https://www.crunchyroll.com/watch/example",
          state: "paused",
          currentTime: 12,
          duration: 120,
          playbackRate: 1,
          updatedAt: 10,
        },
      }),
    );

    expect(message?.type).toBe("host_transferred");
  });

  it("rejects messages from another protocol version", () => {
    expect(
      parseServerMessage(
        JSON.stringify({
          type: "presence",
          version: PROTOCOL_VERSION - 1,
          roomId: "room-1",
          participantCount: 1,
          participants: [],
          hostSessionId: "host-1",
        }),
      ),
    ).toBeNull();
  });
});
