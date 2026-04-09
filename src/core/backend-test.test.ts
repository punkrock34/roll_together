import { describe, expect, it } from "vitest";

import {
  buildHealthCheckUrl,
  isValidBackendWebSocketUrl,
  summarizeBackendConnectionTest,
} from "./backend-test";

describe("backend connection helpers", () => {
  it("builds a health check url from an http base url", () => {
    expect(buildHealthCheckUrl("https://watch.example.com")).toBe(
      "https://watch.example.com/health",
    );
  });

  it("preserves a base path when building the health check url", () => {
    expect(
      buildHealthCheckUrl("https://watch.example.com/roll-together/"),
    ).toBe("https://watch.example.com/roll-together/health");
  });

  it("accepts valid socket urls", () => {
    expect(isValidBackendWebSocketUrl("https://watch.example.com/ws")).toBe(
      true,
    );
    expect(isValidBackendWebSocketUrl("wss://watch.example.com/ws")).toBe(true);
  });

  it("summarizes a full success clearly", () => {
    const result = summarizeBackendConnectionTest(
      { ok: true, message: "Health endpoint responded." },
      { ok: true, message: "WebSocket connection opened." },
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("passed");
  });

  it("summarizes a websocket failure clearly", () => {
    const result = summarizeBackendConnectionTest(
      { ok: true, message: "Health endpoint responded." },
      { ok: false, message: "WebSocket connection failed." },
    );

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("WebSocket");
  });
});
