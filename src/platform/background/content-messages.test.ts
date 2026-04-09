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
    sessionId: "session-1",
    hostSessionId: "session-1",
    controlMode: "host_only",
    canControlPlayback: true,
    canNavigateEpisodes: true,
    canTransferHost: true,
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
  it("sends play command for play transitions when playback authority is granted", () => {
    const connectSession = vi.fn();
    const sendPlaybackCommand = vi.fn();
    const sendNavigateEpisode = vi.fn();
    const requestRoomState = vi.fn();
    const publishRoomState = vi.fn();
    const controller = createContentMessageController({
      connectSession,
      sendPlaybackCommand,
      sendNavigateEpisode,
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
    expect(sendNavigateEpisode).not.toHaveBeenCalled();
  });

  it("does not send playback commands for heartbeat snapshots", () => {
    const sendPlaybackCommand = vi.fn();
    const controller = createContentMessageController({
      connectSession: vi.fn(),
      sendPlaybackCommand,
      sendNavigateEpisode: vi.fn(),
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

  it("sends navigate_episode when local episode changes and navigate authority is granted", () => {
    const sendPlaybackCommand = vi.fn();
    const sendNavigateEpisode = vi.fn();
    const controller = createContentMessageController({
      connectSession: vi.fn(),
      sendPlaybackCommand,
      sendNavigateEpisode,
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
    expect(sendNavigateEpisode).toHaveBeenCalledTimes(1);
  });

  it("does not send navigate_episode when navigation authority is denied", () => {
    const sendNavigateEpisode = vi.fn();
    const requestRoomState = vi.fn();
    const controller = createContentMessageController({
      connectSession: vi.fn(),
      sendPlaybackCommand: vi.fn(),
      sendNavigateEpisode,
      requestRoomState,
      publishRoomState: vi.fn(),
    });

    const session = createSession();
    session.canNavigateEpisodes = false;
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
      playback: { ...playback, state: "playing", updatedAt: 71 },
      reason: "play",
    };

    controller.handleContentMessage(session, message, createPort() as never);
    expect(sendNavigateEpisode).not.toHaveBeenCalled();
    expect(requestRoomState).toHaveBeenCalledTimes(1);
  });

  it("tracks content command outcomes as internal lifecycle state", () => {
    const controller = createContentMessageController({
      connectSession: vi.fn(),
      sendPlaybackCommand: vi.fn(),
      sendNavigateEpisode: vi.fn(),
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
});
