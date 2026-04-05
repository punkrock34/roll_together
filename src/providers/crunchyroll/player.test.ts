import { describe, expect, it } from "vitest";

import {
  deriveEpisodeTitle,
  extractEpisodeInfo,
  findCrunchyrollPlayer,
  sanitizeCrunchyrollEpisodeUrl,
} from "./player";

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
      episodeUrl: "https://www.crunchyroll.com/watch/ABCD123/example",
      episodeTitle: "Episode 2",
    });
  });

  it("prefers a ready video element", () => {
    const primary = document.createElement("video");
    primary.id = "player0";
    Object.defineProperty(primary, "readyState", { value: 4 });

    const secondary = document.createElement("video");
    secondary.id = "fallback";

    document.body.append(primary, secondary);

    expect(findCrunchyrollPlayer(document)).toBe(primary);
    document.body.innerHTML = "";
  });

  it("finds a player inside an open shadow root", () => {
    const host = document.createElement("div");
    const shadowRoot = host.attachShadow({ mode: "open" });
    const shadowVideo = document.createElement("video");

    Object.defineProperty(shadowVideo, "readyState", { value: 4 });

    shadowRoot.append(shadowVideo);
    document.body.append(host);

    expect(findCrunchyrollPlayer(document)).toBe(shadowVideo);
    document.body.innerHTML = "";
  });
});
