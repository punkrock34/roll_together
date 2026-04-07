import { describe, expect, it } from "vitest";

import type { PlaybackSnapshot } from "../../core/protocol";

import {
  consumeRemoteEchoExpectation,
  createRemoteEchoExpectation,
} from "./remote-echo";

const basePlayback: PlaybackSnapshot = {
  provider: "crunchyroll",
  episodeUrl: "https://www.crunchyroll.com/watch/example",
  episodeTitle: "Example Episode",
  state: "paused",
  currentTime: 12,
  duration: 120,
  playbackRate: 1,
  updatedAt: 1,
};

describe("remote echo suppression", () => {
  it("suppresses the expected seek echo once", () => {
    const expectation = createRemoteEchoExpectation(
      { ...basePlayback, currentTime: 24 },
      {
        shouldPlay: false,
        shouldPause: false,
        shouldSeek: true,
        targetTime: 24,
      },
      100,
    );

    const result = consumeRemoteEchoExpectation(
      expectation,
      { ...basePlayback, currentTime: 24.4 },
      200,
    );

    expect(result.shouldSuppress).toBe(true);
    expect(result.nextExpectation).toBeUndefined();
  });

  it("suppresses a delayed play echo after the seek echo", () => {
    const expectation = createRemoteEchoExpectation(
      { ...basePlayback, currentTime: 24, state: "playing" },
      {
        shouldPlay: true,
        shouldPause: false,
        shouldSeek: true,
        targetTime: 24,
      },
      100,
    );

    const afterSeek = consumeRemoteEchoExpectation(
      expectation,
      { ...basePlayback, currentTime: 24.2, state: "paused" },
      200,
    );
    const afterPlay = consumeRemoteEchoExpectation(
      afterSeek.nextExpectation,
      { ...basePlayback, currentTime: 24.6, state: "playing" },
      300,
    );

    expect(afterSeek.shouldSuppress).toBe(true);
    expect(afterSeek.nextExpectation?.shouldPlay).toBe(true);
    expect(afterSeek.nextExpectation?.shouldSeek).toBe(false);
    expect(afterPlay.shouldSuppress).toBe(true);
    expect(afterPlay.nextExpectation).toBeUndefined();
  });

  it("suppresses the expected pause echo once", () => {
    const expectation = createRemoteEchoExpectation(
      { ...basePlayback, currentTime: 24, state: "paused" },
      {
        shouldPlay: false,
        shouldPause: true,
        shouldSeek: false,
        targetTime: 24,
      },
      100,
    );

    const firstResult = consumeRemoteEchoExpectation(
      expectation,
      { ...basePlayback, currentTime: 24.1, state: "paused" },
      200,
    );
    const secondResult = consumeRemoteEchoExpectation(
      firstResult.nextExpectation,
      { ...basePlayback, currentTime: 24.2, state: "paused" },
      300,
    );

    expect(firstResult.shouldSuppress).toBe(true);
    expect(firstResult.nextExpectation).toBeUndefined();
    expect(secondResult.shouldSuppress).toBe(false);
  });

  it("does not suppress divergent local playback", () => {
    const expectation = createRemoteEchoExpectation(
      { ...basePlayback, currentTime: 24, state: "playing" },
      {
        shouldPlay: true,
        shouldPause: false,
        shouldSeek: false,
        targetTime: 24,
      },
      100,
    );

    const result = consumeRemoteEchoExpectation(
      expectation,
      { ...basePlayback, currentTime: 35, state: "playing" },
      200,
    );

    expect(result.shouldSuppress).toBe(false);
    expect(result.nextExpectation).toBeDefined();
  });

  it("expires the expectation when the echo arrives too late", () => {
    const expectation = createRemoteEchoExpectation(
      { ...basePlayback, currentTime: 24, state: "playing" },
      {
        shouldPlay: true,
        shouldPause: false,
        shouldSeek: false,
        targetTime: 24,
      },
      100,
    );

    const result = consumeRemoteEchoExpectation(
      expectation,
      { ...basePlayback, currentTime: 24.4, state: "playing" },
      1_700,
    );

    expect(result.shouldSuppress).toBe(false);
    expect(result.nextExpectation).toBeUndefined();
  });
});
