import { describe, expect, it, vi } from "vitest";

import {
  deriveEpisodeId,
  deriveEpisodeTitle,
  extractEpisodeInfo,
  findCrunchyrollPlayer,
  sanitizeCrunchyrollEpisodeUrl,
  seekCrunchyrollPlayer,
} from "./player";

function mockVideoRect(
  video: HTMLVideoElement,
  options: { width: number; height: number; left?: number; top?: number },
) {
  const left = options.left ?? 0;
  const top = options.top ?? 0;
  const right = left + options.width;
  const bottom = top + options.height;

  Object.defineProperty(video, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      x: left,
      y: top,
      left,
      top,
      right,
      bottom,
      width: options.width,
      height: options.height,
      toJSON: () => ({}),
    }),
  });
}

describe("Crunchyroll provider helpers", () => {
  it("cleans room ids from the episode url", () => {
    expect(
      sanitizeCrunchyrollEpisodeUrl(
        "https://www.crunchyroll.com/watch/ABCD123/example?rollTogetherRoom=room-1",
      ),
    ).toBe("https://www.crunchyroll.com/watch/ABCD123/example");
  });

  it("derives a readable episode title", () => {
    expect(deriveEpisodeTitle("Episode 1 - Crunchyroll")).toBe("Episode 1");
  });

  it("extracts Crunchyroll episode info", () => {
    expect(
      extractEpisodeInfo(
        "https://www.crunchyroll.com/watch/ABCD123/example",
        "Episode 2 | Crunchyroll",
      ),
    ).toEqual({
      provider: "crunchyroll",
      episodeId: "ABCD123",
      episodeUrl: "https://www.crunchyroll.com/watch/ABCD123/example",
      episodeTitle: "Episode 2",
    });
  });

  it("derives a stable episode id from the watch url", () => {
    expect(
      deriveEpisodeId("https://www.crunchyroll.com/watch/G4VUQ1ZKW/example"),
    ).toBe("G4VUQ1ZKW");
  });

  it("prefers a ready video element", () => {
    const primary = document.createElement("video");
    primary.id = "player0";
    Object.defineProperty(primary, "readyState", { value: 4 });
    mockVideoRect(primary, { width: 1280, height: 720 });

    const secondary = document.createElement("video");
    secondary.id = "fallback";
    Object.defineProperty(secondary, "readyState", { value: 4 });
    mockVideoRect(secondary, { width: 640, height: 360 });

    document.body.append(primary, secondary);

    expect(findCrunchyrollPlayer(document)).toBe(primary);
    document.body.innerHTML = "";
  });

  it("filters incidental videos without playback signal", () => {
    const incidental = document.createElement("video");
    incidental.id = "incidental-video";
    Object.defineProperty(incidental, "readyState", { value: 0 });
    Object.defineProperty(incidental, "currentTime", { value: 0 });
    Object.defineProperty(incidental, "duration", { value: NaN });
    mockVideoRect(incidental, { width: 320, height: 180 });

    const primary = document.createElement("video");
    primary.id = "player0";
    Object.defineProperty(primary, "readyState", { value: 1 });
    mockVideoRect(primary, { width: 1280, height: 720 });

    document.body.append(incidental, primary);

    expect(findCrunchyrollPlayer(document)).toBe(primary);
    document.body.innerHTML = "";
  });

  it("finds a player inside an open shadow root", () => {
    const host = document.createElement("div");
    const shadowRoot = host.attachShadow({ mode: "open" });
    const shadowVideo = document.createElement("video");

    Object.defineProperty(shadowVideo, "readyState", { value: 4 });
    mockVideoRect(shadowVideo, { width: 1280, height: 720 });

    shadowRoot.append(shadowVideo);
    document.body.append(host);

    expect(findCrunchyrollPlayer(document)).toBe(shadowVideo);
    document.body.innerHTML = "";
  });

  it("does not crawl into iframe documents from the parent frame", () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);

    const frameDocument = frame.contentDocument;
    expect(frameDocument).toBeTruthy();

    const frameVideo = frameDocument?.createElement("video");
    if (frameVideo && frameDocument) {
      Object.defineProperty(frameVideo, "readyState", { value: 4 });
      frameDocument.body.append(frameVideo);
    }

    // Parent-frame discovery should only consider the parent document/shadow roots.
    expect(findCrunchyrollPlayer(document)).toBeNull();
    document.body.innerHTML = "";
  });

  it("ignores off-screen primary candidates and picks visible playback video", () => {
    const stalePrimary = document.createElement("video");
    stalePrimary.id = "player0";
    Object.defineProperty(stalePrimary, "readyState", { value: 4 });
    Object.defineProperty(stalePrimary, "currentTime", { value: 18 });
    mockVideoRect(stalePrimary, {
      width: 1280,
      height: 720,
      left: -2500,
      top: 0,
    });

    const visibleVideo = document.createElement("video");
    Object.defineProperty(visibleVideo, "readyState", { value: 4 });
    Object.defineProperty(visibleVideo, "currentTime", { value: 19 });
    mockVideoRect(visibleVideo, { width: 1280, height: 720 });

    document.body.append(stalePrimary, visibleVideo);

    expect(findCrunchyrollPlayer(document)).toBe(visibleVideo);
    document.body.innerHTML = "";
  });

  it("uses Crunchyroll new-ui internal seek when available", () => {
    const video = document.createElement("video");
    const seekTo = vi.fn();

    const controls = document.createElement("div");
    controls.setAttribute("data-testid", "bottom-controls-autohide");
    Object.defineProperty(controls, "__reactFiber$test", {
      configurable: true,
      enumerable: true,
      value: {
        child: {
          child: {
            child: {
              child: {
                memoizedProps: {
                  seekTo,
                },
              },
            },
          },
        },
      },
    });

    document.body.append(controls, video);
    const result = seekCrunchyrollPlayer(video, 42.5);

    expect(result.method).toBe("react-seekTo");
    expect(seekTo).toHaveBeenCalledWith(42.5);
    document.body.innerHTML = "";
  });

  it("falls back to fastSeek before currentTime", () => {
    const video = document.createElement("video");
    const fastSeek = vi.fn();
    Object.defineProperty(video, "fastSeek", {
      configurable: true,
      value: fastSeek,
    });
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      writable: true,
      value: 0,
    });

    const result = seekCrunchyrollPlayer(video, 15.25);

    expect(result.method).toBe("fastSeek");
    expect(fastSeek).toHaveBeenCalledWith(15.25);
    expect(video.currentTime).toBe(0);
  });

  it("falls back to currentTime when no special seek API is available", () => {
    const video = document.createElement("video");
    Object.defineProperty(video, "fastSeek", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      writable: true,
      value: 0,
    });

    const result = seekCrunchyrollPlayer(video, 9.75);

    expect(result.method).toBe("currentTime");
    expect(video.currentTime).toBe(9.75);
  });
});
