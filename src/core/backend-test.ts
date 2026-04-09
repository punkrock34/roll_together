import { io, type Socket } from "socket.io-client";

import { isRemotePlainWsUrl, normalizeBackendWsUrl } from "./network-url";

export interface BackendProbeResult {
  ok: boolean;
  message: string;
}

export interface BackendConnectionTestResult {
  ok: boolean;
  health: BackendProbeResult;
  websocket: BackendProbeResult;
  summary: string;
}

function appendPathSegment(pathname: string, segment: string) {
  const normalizedPath = pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;

  return `${normalizedPath}/${segment}`.replace(/\/{2,}/g, "/");
}

export function buildHealthCheckUrl(backendHttpUrl: string) {
  try {
    const url = new URL(backendHttpUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }

    url.pathname = appendPathSegment(url.pathname, "health");
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

export function isValidBackendWebSocketUrl(backendWsUrl: string) {
  try {
    const url = new URL(backendWsUrl);
    return (
      url.protocol === "ws:" ||
      url.protocol === "wss:" ||
      url.protocol === "http:" ||
      url.protocol === "https:"
    );
  } catch {
    return false;
  }
}

export function summarizeBackendConnectionTest(
  health: BackendProbeResult,
  websocket: BackendProbeResult,
): BackendConnectionTestResult {
  if (health.ok && websocket.ok) {
    return {
      ok: true,
      health,
      websocket,
      summary: "Connection test passed. Health and WebSocket both responded.",
    };
  }

  if (health.ok) {
    return {
      ok: false,
      health,
      websocket,
      summary:
        "Connection test failed. The health check worked, but the WebSocket URL did not connect.",
    };
  }

  if (websocket.ok) {
    return {
      ok: false,
      health,
      websocket,
      summary:
        "Connection test failed. The WebSocket connected, but the health check did not respond.",
    };
  }

  return {
    ok: false,
    health,
    websocket,
    summary:
      "Connection test failed. The health check and WebSocket URL both failed.",
  };
}

async function probeHealthEndpoint(
  healthCheckUrl: string,
  timeoutMs: number,
): Promise<BackendProbeResult> {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(healthCheckUrl, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });

    if (response.ok) {
      return {
        ok: true,
        message: "Health endpoint responded.",
      };
    }

    return {
      ok: false,
      message: `Health endpoint returned ${response.status}.`,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return {
        ok: false,
        message: "Health endpoint timed out.",
      };
    }

    return {
      ok: false,
      message: "Health endpoint could not be reached.",
    };
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

function resolveSocketEndpoint(backendWsUrl: string) {
  const parsed = new URL(backendWsUrl);
  const protocol =
    parsed.protocol === "wss:"
      ? "https:"
      : parsed.protocol === "ws:"
        ? "http:"
        : parsed.protocol;

  return {
    baseUrl: `${protocol}//${parsed.host}`,
    path: parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "/ws",
  };
}

function probeSocketIo(
  backendWsUrl: string,
  timeoutMs: number,
): Promise<BackendProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    let socket: Socket | undefined;

    const finish = (result: BackendProbeResult) => {
      if (settled) {
        return;
      }

      settled = true;
      globalThis.clearTimeout(timeoutId);

      if (socket) {
        socket.disconnect();
      }

      resolve(result);
    };

    const timeoutId = globalThis.setTimeout(() => {
      finish({
        ok: false,
        message: "WebSocket connection timed out.",
      });
    }, timeoutMs);

    try {
      const normalizedWsUrl = normalizeBackendWsUrl(backendWsUrl);
      const endpoint = resolveSocketEndpoint(normalizedWsUrl);
      socket = io(endpoint.baseUrl, {
        path: endpoint.path,
        transports: ["websocket"],
        timeout: timeoutMs,
        reconnection: false,
      });
    } catch {
      finish({
        ok: false,
        message: "Socket URL is invalid.",
      });
      return;
    }

    socket.on("connect", () => {
      finish({
        ok: true,
        message: "Socket.IO connection opened.",
      });
    });

    socket.on("connect_error", (error: { message?: string } | undefined) => {
      const errorDetail =
        typeof error?.message === "string" && error.message.trim().length > 0
          ? ` (${error.message.trim()})`
          : "";
      const hint = isRemotePlainWsUrl(backendWsUrl)
        ? " Use wss:// for public HTTPS hosts (for example behind Cloudflare)."
        : "";

      finish({
        ok: false,
        message: `Socket.IO connection failed${errorDetail}.${hint}`,
      });
    });
  });
}

export async function testBackendConnection(
  backendHttpUrl: string,
  backendWsUrl: string,
  timeoutMs = 3_500,
): Promise<BackendConnectionTestResult> {
  const healthCheckUrl = buildHealthCheckUrl(backendHttpUrl);
  const healthPromise = healthCheckUrl
    ? probeHealthEndpoint(healthCheckUrl, timeoutMs)
    : Promise.resolve<BackendProbeResult>({
        ok: false,
        message: "HTTP base URL is invalid.",
      });

  const websocketPromise = isValidBackendWebSocketUrl(backendWsUrl)
    ? probeSocketIo(backendWsUrl, timeoutMs)
    : Promise.resolve<BackendProbeResult>({
        ok: false,
        message: "Socket URL is invalid.",
      });

  const [health, websocket] = await Promise.all([
    healthPromise,
    websocketPromise,
  ]);
  return summarizeBackendConnectionTest(health, websocket);
}
