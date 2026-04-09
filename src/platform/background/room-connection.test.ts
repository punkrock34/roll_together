import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  BackgroundOutboundMessage,
  ContentPlayerStateMessage,
} from "../../core/messages";
import { PROTOCOL_VERSION, type PlaybackSnapshot } from "../../core/protocol";
import type { TabSession } from "./session-state";
import {
  createRoomConnectionController,
  evaluatePlayerStateConvergence,
  shouldApplyRoomRevision,
} from "./room-connection";

const mockIo = vi.fn();
const mockTabsUpdate = vi.fn(async (...args: unknown[]) => {
  void args;
  return undefined;
});

vi.mock("socket.io-client", () => ({
  io: (baseUrl: unknown, options: unknown) => mockIo(baseUrl, options),
}));

vi.mock("wxt/browser", () => ({
  browser: {
    tabs: {
      update: (tabId: unknown, updateProperties: unknown) =>
        mockTabsUpdate(tabId, updateProperties),
    },
  },
}));

vi.mock("../../core/storage", () => ({
  getSettings: vi.fn(async () => ({
    backendHttpUrl: "http://localhost:8787",
    backendWsUrl: "ws://localhost:8787/ws",
    displayName: "Guest",
  })),
  upsertRecentRoom: vi.fn(async () => undefined),
}));

class FakeSocket {
  connected = true;
  emitted: Array<{ event: string; payload: unknown }> = [];
  private handlers = new Map<string, Array<(payload?: unknown) => void>>();

  on(event: string, handler: (payload?: unknown) => void) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  emit(event: string, payload: unknown) {
    this.emitted.push({ event, payload });
    return true;
  }

  disconnect() {
    this.connected = false;
  }

  trigger(event: string, payload?: unknown) {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(payload);
    }
  }
}

const localPlayback: PlaybackSnapshot = {
  provider: "crunchyroll",
  episodeId: "G4VUQ1ZKW",
  episodeUrl: "https://www.crunchyroll.com/watch/G4VUQ1ZKW/example",
  episodeTitle: "Episode 7",
  state: "paused",
  currentTime: 1,
  duration: 100,
  playbackRate: 1,
  updatedAt: 1000,
};

function createSession(): TabSession {
  return {
    tabId: 1,
    ports: new Map(),
    participantCount: 1,
    participants: [],
    connectionState: "ready",
    canControlPlayback: false,
    canNavigateEpisodes: false,
    canTransferHost: false,
    reconnectAttempt: 0,
    localPlayback: { ...localPlayback },
  };
}

function buildRoomJoinedPayload(revision = 2) {
  const now = Date.now();
  return {
    version: PROTOCOL_VERSION,
    roomId: "room-1",
    sessionId: "session-1",
    state: {
      roomId: "room-1",
      revision,
      updatedAt: now,
      hostSessionId: "session-1",
      controlMode: "host_only" as const,
      navigationRevision: 0,
      playback: {
        ...localPlayback,
        state: "playing" as const,
        currentTime: 12,
        updatedAt: now,
      },
      participants: [
        {
          sessionId: "session-1",
          displayName: "Guest",
          isHost: true,
          joinedAt: now,
          lastSeenAt: now,
          connected: true,
        },
      ],
      participantCount: 1,
    },
  };
}

function buildRoomNavigationPayload() {
  const now = Date.now();
  return {
    version: PROTOCOL_VERSION,
    roomId: "room-1",
    revision: 5,
    navigationRevision: 1,
    initiatedBySessionId: "session-2",
    updatedAt: now,
    playback: {
      ...localPlayback,
      episodeId: "G123NEWEP",
      episodeUrl: "https://www.crunchyroll.com/watch/G123NEWEP/example",
      episodeTitle: "Episode 8",
      state: "paused" as const,
      currentTime: 0,
      updatedAt: now,
    },
  };
}

function createControllerHarness() {
  const fakeSocket = new FakeSocket();
  mockIo.mockReturnValue(fakeSocket);
  const postToContent = vi.fn(
    (session: TabSession, message: BackgroundOutboundMessage) => {
      void session;
      void message;
      return true;
    },
  );
  const controller = createRoomConnectionController({
    publishRoomState: vi.fn(),
    queuePopupStatePublish: vi.fn(),
    postToContent,
  });
  return { controller, fakeSocket, postToContent };
}

describe("room connection revision gating", () => {
  it("accepts first snapshot when no revision has been applied", () => {
    expect(shouldApplyRoomRevision(undefined, 1)).toBe(true);
  });

  it("accepts only newer revisions", () => {
    expect(shouldApplyRoomRevision(3, 4)).toBe(true);
    expect(shouldApplyRoomRevision(3, 3)).toBe(false);
    expect(shouldApplyRoomRevision(3, 2)).toBe(false);
  });
});

describe("bounded command verification", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockIo.mockReset();
    mockTabsUpdate.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks applied only after polled player state converges", async () => {
    const { controller, fakeSocket, postToContent } = createControllerHarness();
    const session = createSession();

    await controller.connectSession(session, "room-1");
    fakeSocket.trigger("connect");
    fakeSocket.trigger("room_joined", buildRoomJoinedPayload(2));

    const applyMessage = postToContent.mock.calls
      .map((call) => call[1] as BackgroundOutboundMessage)
      .find((message) => message.type === "background:apply-state-snapshot");
    expect(applyMessage?.type).toBe("background:apply-state-snapshot");
    if (
      !applyMessage ||
      applyMessage.type !== "background:apply-state-snapshot"
    ) {
      return;
    }

    const firstPlayerState = {
      paused: false,
      currentTime: 12,
      duration: 100,
      playbackRate: 1,
      readyState: 3,
      seeking: false,
      ended: false,
      episodeId: "G4VUQ1ZKW",
      updatedAt: Date.now(),
    };

    const firstSample: ContentPlayerStateMessage = {
      type: "content:player-state",
      commandId: applyMessage.commandId,
      revision: applyMessage.revision,
      roomId: applyMessage.roomId,
      playerState: firstPlayerState,
      playback: {
        ...localPlayback,
        state: "playing",
        currentTime: 12,
        updatedAt: Date.now(),
      },
    };

    controller.handlePlayerState(session, firstSample);
    expect(session.latestCommandStatus).toBe("delivered");

    const secondSample: ContentPlayerStateMessage = {
      ...firstSample,
      playerState: {
        ...firstPlayerState,
        currentTime: 12.4,
        updatedAt: Date.now() + 200,
      },
      playback: {
        ...firstSample.playback!,
        currentTime: 12.4,
        updatedAt: Date.now() + 200,
      },
    };

    controller.handlePlayerState(session, secondSample);
    expect(session.latestCommandStatus).toBe("applied");
    expect(session.latestAppliedRevision).toBe(2);
  });

  it("marks timed_out and requests canonical state once when convergence fails", async () => {
    const { controller, fakeSocket } = createControllerHarness();
    const session = createSession();

    await controller.connectSession(session, "room-1");
    fakeSocket.trigger("connect");
    fakeSocket.trigger("room_joined", buildRoomJoinedPayload(3));

    vi.advanceTimersByTime(4_200);

    expect(session.latestCommandStatus).toBe("timed_out");
    const requestStateCalls = fakeSocket.emitted.filter(
      (event) => event.event === "request_state",
    );
    expect(requestStateCalls).toHaveLength(1);
  });

  it("does not issue a second apply command for the same revision while verification is active", async () => {
    const { controller, fakeSocket, postToContent } = createControllerHarness();
    const session = createSession();

    await controller.connectSession(session, "room-1");
    fakeSocket.trigger("connect");

    const payload = buildRoomJoinedPayload(4);
    fakeSocket.trigger("room_joined", payload);
    fakeSocket.trigger("state_snapshot", {
      version: PROTOCOL_VERSION,
      state: payload.state,
    });

    const applyCount = postToContent.mock.calls
      .map((call) => call[1] as BackgroundOutboundMessage)
      .filter(
        (message) => message.type === "background:apply-state-snapshot",
      ).length;

    expect(applyCount).toBe(1);
  });

  it("follows remote room_navigation by navigating the tab", async () => {
    const { controller, fakeSocket } = createControllerHarness();
    const session = createSession();

    await controller.connectSession(session, "room-1");
    fakeSocket.trigger("connect");
    fakeSocket.trigger("room_joined", buildRoomJoinedPayload(4));
    fakeSocket.trigger("room_navigation", buildRoomNavigationPayload());

    expect(session.connectionState).toBe("switching");
    expect(mockTabsUpdate).toHaveBeenCalledTimes(1);
    expect(mockTabsUpdate).toHaveBeenCalledWith(
      session.tabId,
      expect.objectContaining({
        url: expect.stringContaining("rollTogetherRoom=room-1"),
      }),
    );
  });
});

describe("player-state convergence helper", () => {
  it("requires ready, playing, non-ended progression for play convergence", () => {
    const first = evaluatePlayerStateConvergence(
      {
        targetState: "playing",
        expectedTime: 10,
        requiresSeek: false,
      },
      {
        paused: false,
        currentTime: 10,
        duration: 100,
        playbackRate: 1,
        readyState: 3,
        seeking: false,
        ended: false,
        episodeId: "G4VUQ1ZKW",
        updatedAt: 100,
      },
      {},
      100,
    );
    expect(first.converged).toBe(false);

    const second = evaluatePlayerStateConvergence(
      {
        targetState: "playing",
        expectedTime: 10,
        requiresSeek: false,
      },
      {
        paused: false,
        currentTime: 10.4,
        duration: 100,
        playbackRate: 1,
        readyState: 3,
        seeking: false,
        ended: false,
        episodeId: "G4VUQ1ZKW",
        updatedAt: 300,
      },
      first.progress,
      300,
    );
    expect(second.converged).toBe(true);
  });
});
