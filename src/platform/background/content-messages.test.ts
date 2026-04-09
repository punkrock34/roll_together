import { describe, expect, it, vi } from "vitest";

import type { ContentOutboundMessage } from "../../core/messages";
import type { PlaybackSnapshot } from "../../core/protocol";
import type { TabSession } from "./session-state";
import { createContentMessageController } from "./content-messages";

vi.mock("../../core/storage", () => ({
  upsertWatchProgress: vi.fn(() => Promise.resolve()),
}));

const playback: PlaybackSnapshot = {
  provider: "crunchyroll",
  episodeId: "G4VUQ1ZKW",
  episodeUrl: "https://www.crunchyroll.com/watch/G4VUQ1ZKW/example",
  episodeTitle: "Episode 1",
  state: "paused",
  currentTime: 10,
  duration: 120,
  playbackRate: 1,
  updatedAt: 1,
};

function createSession(): TabSession {
  return {
    tabId: 1,
    ports: new Map(),
    participantCount: 1,
    participants: [],
    connectionState: "connected",
    reconnectAttempt: 0,
    roomId: "room-1",
    roomPlayback: playback,
    localPlayback: playback,
    socket: undefined,
  };
}

function createPort() {
  return {
    sender: {
      frameId: 0,
      tab: {
        url: playback.episodeUrl,
        title: playback.episodeTitle,
      },
    },
  } as const;
}

describe("content message controller", () => {
  it("sends play command for play transitions", () => {
    const connectSession = vi.fn();
    const sendPlaybackCommand = vi.fn();
    const requestRoomState = vi.fn();
    const publishRoomState = vi.fn();
    const controller = createContentMessageController({
      connectSession,
      sendPlaybackCommand,
      requestRoomState,
      publishRoomState,
    });

    const session = createSession();
    const message: ContentOutboundMessage = {
      type: "content:snapshot",
      tabUrl: playback.episodeUrl,
      episode: {
        provider: "crunchyroll",
        episodeId: playback.episodeId,
        episodeUrl: playback.episodeUrl,
        episodeTitle: playback.episodeTitle,
      },
      playback: { ...playback, state: "playing", updatedAt: 50 },
      reason: "play",
    };

    controller.handleContentMessage(session, message, createPort() as never);

    expect(sendPlaybackCommand).toHaveBeenCalledTimes(1);
    expect(sendPlaybackCommand).toHaveBeenCalledWith(
      session,
      "play",
      expect.objectContaining({ state: "playing" }),
    );
  });

  it("does not send playback commands for heartbeat snapshots", () => {
    const sendPlaybackCommand = vi.fn();
    const controller = createContentMessageController({
      connectSession: vi.fn(),
      sendPlaybackCommand,
      requestRoomState: vi.fn(),
      publishRoomState: vi.fn(),
    });

    const session = createSession();
    const message: ContentOutboundMessage = {
      type: "content:snapshot",
      tabUrl: playback.episodeUrl,
      episode: {
        provider: "crunchyroll",
        episodeId: playback.episodeId,
        episodeUrl: playback.episodeUrl,
        episodeTitle: playback.episodeTitle,
      },
      playback: { ...playback, state: "playing", updatedAt: 60 },
      reason: "heartbeat",
    };

    controller.handleContentMessage(session, message, createPort() as never);
    expect(sendPlaybackCommand).not.toHaveBeenCalled();
  });

  it("ignores command send when local episode mismatches room episode", () => {
    const sendPlaybackCommand = vi.fn();
    const controller = createContentMessageController({
      connectSession: vi.fn(),
      sendPlaybackCommand,
      requestRoomState: vi.fn(),
      publishRoomState: vi.fn(),
    });

    const session = createSession();
    session.roomPlayback = {
      ...playback,
      episodeId: "OTHER_EPISODE",
      episodeUrl: "https://www.crunchyroll.com/watch/OTHER_EPISODE/example",
    };

    const message: ContentOutboundMessage = {
      type: "content:snapshot",
      tabUrl: playback.episodeUrl,
      episode: {
        provider: "crunchyroll",
        episodeId: playback.episodeId,
        episodeUrl: playback.episodeUrl,
        episodeTitle: playback.episodeTitle,
      },
      playback: { ...playback, state: "playing", updatedAt: 70 },
      reason: "play",
    };

    controller.handleContentMessage(session, message, createPort() as never);
    expect(sendPlaybackCommand).not.toHaveBeenCalled();
  });

  it("tracks content command outcomes as internal lifecycle state", () => {
    const controller = createContentMessageController({
      connectSession: vi.fn(),
      sendPlaybackCommand: vi.fn(),
      requestRoomState: vi.fn(),
      publishRoomState: vi.fn(),
    });

    const session = createSession();
    session.latestDeliveredCommandId = "command-1";
    session.latestCommandStatus = "delivered";

    const resultMessage: ContentOutboundMessage = {
      type: "content:command-result",
      commandId: "command-1",
      revision: 4,
      status: "applied",
      snapshot: {
        ...playback,
        state: "playing",
        currentTime: 24,
      },
    };

    controller.handleContentMessage(
      session,
      resultMessage,
      createPort() as never,
    );

    expect(session.latestCommandStatus).toBe("applied");
    expect(session.latestAppliedRevision).toBe(4);
    expect(session.localPlayback?.currentTime).toBe(24);
  });

  it("requests canonical state on heartbeat mismatch without emitting commands", () => {
    const sendPlaybackCommand = vi.fn();
    const requestRoomState = vi.fn();
    const controller = createContentMessageController({
      connectSession: vi.fn(),
      sendPlaybackCommand,
      requestRoomState,
      publishRoomState: vi.fn(),
    });

    const session = createSession();
    session.roomPlayback = { ...playback, state: "playing", currentTime: 40 };

    const message: ContentOutboundMessage = {
      type: "content:snapshot",
      tabUrl: playback.episodeUrl,
      episode: {
        provider: "crunchyroll",
        episodeId: playback.episodeId,
        episodeUrl: playback.episodeUrl,
        episodeTitle: playback.episodeTitle,
      },
      playback: { ...playback, state: "paused", currentTime: 12, updatedAt: 90 },
      reason: "heartbeat",
    };

    controller.handleContentMessage(session, message, createPort() as never);

    expect(sendPlaybackCommand).not.toHaveBeenCalled();
    expect(requestRoomState).toHaveBeenCalledTimes(1);
    expect(requestRoomState).toHaveBeenCalledWith(session);
  });
});
