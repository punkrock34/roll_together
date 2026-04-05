import "./style.css";

import { browser, getActiveTab } from "../../src/platform/browser";
import { POPUP_PORT_NAME } from "../../src/core/messages";
import {
  DEFAULT_SETTINGS,
  getSettings,
  listRecentRooms,
} from "../../src/core/storage";
import type {
  PopupStateResponse,
  PopupRequestMessage,
} from "../../src/core/messages";
import { isCrunchyrollUrl } from "../../src/providers/crunchyroll/player";

const app = document.querySelector<HTMLDivElement>("#app");
const POPUP_MESSAGE_RETRY_DELAY_MS = 150;

function statusLabel(state: PopupStateResponse) {
  if (!state.supported) {
    return "Unsupported page";
  }
  if (state.connectionState === "connected") {
    return "Connected";
  }
  if (state.connectionState === "connecting") {
    return "Connecting";
  }
  if (state.connectionState === "error") {
    return "Connection issue";
  }
  if (!state.providerReady) {
    return "Waiting for player";
  }
  return "Ready";
}

function progressLabel(state: PopupStateResponse) {
  if (!state.watchProgress) {
    return "No local progress tracked yet.";
  }

  const minutes = Math.floor(state.watchProgress.progressSeconds / 60);
  return `Tracked locally at ${minutes}m on this episode.`;
}

async function sendPopupMessage<TResponse>(message: PopupRequestMessage) {
  return new Promise<TResponse | undefined>((resolve) => {
    const port = browser.runtime.connect({ name: POPUP_PORT_NAME });
    let settled = false;

    const finish = (value: TResponse | undefined) => {
      if (settled) {
        return;
      }

      settled = true;
      try {
        port.disconnect();
      } catch {
        // Ignore disconnect races when the background already closed the port.
      }
      resolve(value);
    };

    const timeoutId = window.setTimeout(() => {
      finish(undefined);
    }, 500);

    port.onMessage.addListener((response) => {
      window.clearTimeout(timeoutId);
      finish(response as TResponse);
    });

    port.onDisconnect.addListener(() => {
      window.clearTimeout(timeoutId);
      finish(undefined);
    });

    try {
      port.postMessage(message);
    } catch {
      window.clearTimeout(timeoutId);
      finish(undefined);
    }
  });
}

async function copyShareUrl(url: string) {
  await navigator.clipboard.writeText(url);
}

async function createFallbackState(
  lastError = "Extension state is still loading. Try again in a moment.",
): Promise<PopupStateResponse> {
  const [activeTab, settings, recentRooms] = await Promise.all([
    getActiveTab().catch(() => undefined),
    getSettings().catch(() => DEFAULT_SETTINGS),
    listRecentRooms().catch(() => []),
  ]);
  const supported =
    typeof activeTab?.url === "string" && isCrunchyrollUrl(activeTab.url);

  return {
    activeTabId: activeTab?.id,
    activeTabUrl: activeTab?.url,
    supported,
    providerReady: false,
    connectionState: supported ? "ready" : "unsupported",
    participantCount: 0,
    backendWsUrl: settings.backendWsUrl,
    recentRooms: recentRooms.slice(0, 5),
    lastError,
  };
}

function normalizePopupState(
  state: PopupStateResponse | undefined,
  fallbackState: PopupStateResponse,
): PopupStateResponse {
  if (!state) {
    return fallbackState;
  }

  return {
    ...fallbackState,
    ...state,
    recentRooms: Array.isArray(state.recentRooms)
      ? state.recentRooms
      : fallbackState.recentRooms,
    lastError: state.lastError,
  };
}

async function waitForBackground() {
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, POPUP_MESSAGE_RETRY_DELAY_MS);
  });
}

function render(state: PopupStateResponse) {
  if (!app) {
    return;
  }

  const recentRooms = (state.recentRooms ?? [])
    .map(
      (room) => `
        <li>
          <a href="${room.shareUrl}" target="_blank">
            <strong>${room.episodeTitle}</strong><br />
            <span class="muted">${room.roomId}</span>
          </a>
        </li>
      `,
    )
    .join("");

  app.innerHTML = `
    <div class="shell">
      <section class="hero">
        <h1>Roll Together v2</h1>
        <p>Anonymous Crunchyroll sync with local-first watch tracking and self-hosted rooms.</p>
      </section>

      <section class="panel">
        <div class="status">
          <div>
            <strong>${state.episodeTitle ?? "Open a Crunchyroll episode"}</strong><br />
            <span class="muted">${progressLabel(state)}</span>
          </div>
          <span class="pill">${statusLabel(state)}</span>
        </div>

        ${
          state.shareUrl
            ? `<input class="share-url" readonly value="${state.shareUrl}" />`
            : `<p class="muted">Create a room from an active Crunchyroll tab to generate a share link.</p>`
        }

        <div class="actions">
          <button class="primary" data-action="create" ${
            !state.supported || !state.providerReady ? "disabled" : ""
          }>
            ${state.roomId ? "Reconnect Room" : "Create Room"}
          </button>
          <button class="secondary" data-action="copy" ${
            !state.shareUrl ? "disabled" : ""
          }>
            Copy Link
          </button>
          <button class="secondary" data-action="disconnect" ${
            !state.roomId ? "disabled" : ""
          }>
            Leave
          </button>
        </div>

        ${
          state.lastError
            ? `<p class="muted">${state.lastError}</p>`
            : `<p class="muted">Backend: ${state.backendWsUrl}</p>`
        }
      </section>

      <section class="panel">
        <strong>Recent Rooms</strong>
        ${
          recentRooms
            ? `<ul class="list">${recentRooms}</ul>`
            : `<p class="muted">Room links you create or join will appear here.</p>`
        }
      </section>
    </div>
  `;

  app
    .querySelector<HTMLButtonElement>("[data-action='create']")
    ?.addEventListener("click", async () => {
      const activeTab = await getActiveTab();
      if (!activeTab?.id) {
        return;
      }

      await sendPopupMessage<PopupStateResponse>({
        type: "popup:create-room",
        tabId: activeTab.id,
      });

      await refresh();
    });

  app
    .querySelector<HTMLButtonElement>("[data-action='copy']")
    ?.addEventListener("click", async () => {
      if (state.shareUrl) {
        await copyShareUrl(state.shareUrl);
      }
    });

  app
    .querySelector<HTMLButtonElement>("[data-action='disconnect']")
    ?.addEventListener("click", async () => {
      const activeTab = await getActiveTab();
      if (!activeTab?.id) {
        return;
      }

      await sendPopupMessage<PopupStateResponse>({
        type: "popup:disconnect-room",
        tabId: activeTab.id,
      });

      await refresh();
    });
}

async function refresh() {
  const fallbackState = await createFallbackState();
  let state = await sendPopupMessage<PopupStateResponse>({
    type: "popup:get-active-tab-state",
  });

  if (!state) {
    await waitForBackground();
    state = await sendPopupMessage<PopupStateResponse>({
      type: "popup:get-active-tab-state",
    });
  }

  render(normalizePopupState(state, fallbackState));
}

void refresh();
