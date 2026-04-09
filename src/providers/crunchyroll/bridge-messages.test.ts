import { describe, expect, it } from "vitest";

import {
  createBridgeEnvelope,
  isBridgeEnvelope,
  isContentToPageMessage,
  isPageToContentMessage,
} from "./bridge-messages";

describe("crunchyroll bridge messages", () => {
  it("accepts valid bridge envelopes", () => {
    const message = createBridgeEnvelope("bridge-1", "bridge:init", {
      tabUrl: "https://www.crunchyroll.com/watch/G4VUQ1ZKW/example",
      title: "Episode",
      issuedAt: 1,
    });

    expect(isBridgeEnvelope(message)).toBe(true);
    expect(isContentToPageMessage(message, "bridge-1")).toBe(true);
    expect(isPageToContentMessage(message, "bridge-1")).toBe(false);
  });

  it("accepts only page-to-content messages with matching bridge id", () => {
    const message = createBridgeEnvelope("bridge-2", "bridge:ready", {
      tabUrl: "https://www.crunchyroll.com/watch/G4VUQ1ZKW/example",
      issuedAt: 123,
    });

    expect(isPageToContentMessage(message, "bridge-2")).toBe(true);
    expect(isPageToContentMessage(message, "bridge-other")).toBe(false);
  });

  it("rejects malformed bridge envelopes", () => {
    expect(isBridgeEnvelope({ type: "bridge:init" })).toBe(false);
    expect(
      isBridgeEnvelope({
        namespace: "wrong-namespace",
        version: 1,
        bridgeId: "bridge-1",
        type: "bridge:init",
        payload: {},
      }),
    ).toBe(false);
  });
});
