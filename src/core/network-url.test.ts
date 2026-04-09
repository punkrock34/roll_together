import { describe, expect, it } from "vitest";

import {
  isLocalLikeHostname,
  isRemotePlainWsUrl,
  normalizeBackendWsUrl,
} from "./network-url";

describe("network url helpers", () => {
  it("detects local-like hostnames", () => {
    expect(isLocalLikeHostname("localhost")).toBe(true);
    expect(isLocalLikeHostname("127.0.0.1")).toBe(true);
    expect(isLocalLikeHostname("192.168.1.2")).toBe(true);
    expect(isLocalLikeHostname("watch.local")).toBe(true);
    expect(isLocalLikeHostname("rt.punkrock.cloud")).toBe(false);
  });

  it("detects remote ws urls that should use wss", () => {
    expect(isRemotePlainWsUrl("ws://rt.punkrock.cloud/ws")).toBe(true);
    expect(isRemotePlainWsUrl("ws://localhost:3000/ws")).toBe(false);
    expect(isRemotePlainWsUrl("wss://rt.punkrock.cloud/ws")).toBe(false);
  });

  it("upgrades remote ws urls to wss and keeps localhost ws", () => {
    expect(normalizeBackendWsUrl("ws://rt.punkrock.cloud/ws")).toBe(
      "wss://rt.punkrock.cloud/ws",
    );
    expect(normalizeBackendWsUrl("ws://localhost:3000/ws")).toBe(
      "ws://localhost:3000/ws",
    );
  });
});
