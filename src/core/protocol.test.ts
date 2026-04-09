import { describe, expect, it } from "vitest";

import {
  PROTOCOL_VERSION,
  parseCommandErrorPayload,
  parseRoomJoinedPayload,
  parseStateSnapshotPayload,
} from "./protocol";

const basePlayback = {
  provider: "crunchyroll" as const,
  episodeId: "G4VUQ1ZKW",
  episodeTitle: "Episode 1",
  episodeUrl: "https://www.crunchyroll.com/watch/G4VUQ1ZKW/example",
  state: "paused" as const,
  currentTime: 12,
  duration: 120,
  playbackRate: 1,
  updatedAt: 100,
};

describe("extension protocol payload validators", () => {
  it("parses a valid room_joined payload", () => {
    const message = parseRoomJoinedPayload({
      version: PROTOCOL_VERSION,
      roomId: "room-1",
      sessionId: "session-1",
      state: {
        roomId: "room-1",
        revision: 1,
        updatedAt: 100,
        playback: basePlayback,
        participantCount: 1,
        participants: [
          {
            sessionId: "session-1",
            displayName: "Guest",
            isHost: false,
            joinedAt: 90,
            lastSeenAt: 100,
            connected: true,
          },
        ],
      },
    });

    expect(message?.roomId).toBe("room-1");
    expect(message?.state.playback.episodeId).toBe("G4VUQ1ZKW");
  });

  it("parses a valid state_snapshot payload", () => {
    const message = parseStateSnapshotPayload({
      version: PROTOCOL_VERSION,
      state: {
        roomId: "room-1",
        revision: 2,
        updatedAt: 200,
        playback: {
          ...basePlayback,
          state: "playing",
          currentTime: 20,
        },
        participantCount: 2,
        participants: [],
      },
    });

    expect(message?.state.revision).toBe(2);
    expect(message?.state.playback.state).toBe("playing");
  });

  it("rejects messages from another protocol version", () => {
    expect(
      parseStateSnapshotPayload({
        version: PROTOCOL_VERSION - 1,
        state: {
          roomId: "room-1",
          revision: 2,
          updatedAt: 200,
          playback: basePlayback,
          participantCount: 0,
          participants: [],
        },
      }),
    ).toBeNull();
  });

  it("parses known command_error payloads", () => {
    const message = parseCommandErrorPayload({
      version: PROTOCOL_VERSION,
      code: "episode_mismatch",
      message: "Room episode differs",
    });

    expect(message?.code).toBe("episode_mismatch");
  });
});
