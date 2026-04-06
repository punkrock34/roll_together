import "./style.css";

import { browser, getActiveTab } from "../../src/platform/browser";
import {
  POPUP_PORT_NAME,
  POPUP_STATE_PORT_NAME,
} from "../../src/core/messages";
import {
  DEFAULT_SETTINGS,
  deleteRecentRoom,
  getSettings,
  listRecentRooms,
  renameRecentRoom,
  saveSettings,
  type ExtensionSettings,
  type RecentRoomEntry,
  type ThemeMode,
} from "../../src/core/storage";
import type {
  PopupRequestMessage,
  PopupStateResponse,
} from "../../src/core/messages";
import { isCrunchyrollUrl } from "../../src/providers/crunchyroll/player";
import { applyThemeMode } from "../../src/ui/theme";

type PopupTab = "home" | "rooms" | "settings";

interface PopupViewModel {
  popupState: PopupStateResponse;
  settings: ExtensionSettings;
  recentRooms: RecentRoomEntry[];
}

interface PopupUiState {
  activeTab: PopupTab;
  editingRoomId?: string;
  notice?: string;
}

const app = document.querySelector<HTMLDivElement>("#app");
const TAB_LABELS: Record<PopupTab, string> = {
  home: "Home",
  rooms: "Rooms",
  settings: "Settings",
};
const THEME_LABELS: Record<ThemeMode, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

const uiState: PopupUiState = {
  activeTab: "home",
};
let popupStatePort: ReturnType<typeof browser.runtime.connect> | undefined;
let livePopupState: PopupStateResponse | undefined;
let renderQueued = false;
let popupStateResolvers: Array<
  (state: PopupStateResponse | undefined) => void
> = [];

function roomStatusLabel(state: PopupStateResponse) {
  if (!state.supported) {
    return "Unsupported";
  }

  switch (state.connectionState) {
    case "connected":
      return state.isHost ? "Hosting" : "Following";
    case "connecting":
      return "Connecting";
    case "switching":
      return "Switching";
    case "error":
      return "Issue";
    default:
      return state.providerReady ? "Ready" : "Waiting";
  }
}

function progressLabel(state: PopupStateResponse) {
  if (!state.watchProgress) {
    return "No local watch progress saved for this episode yet.";
  }

  const minutes = Math.floor(state.watchProgress.progressSeconds / 60);
  return `Saved locally at ${minutes}m.`;
}

function roomRoleLabel(state: PopupStateResponse) {
  if (!state.roomId) {
    return "Not in a room";
  }

  return state.isHost ? "You control this room" : "Following the current host";
}

function describeHomeState(state: PopupStateResponse) {
  if (!state.supported) {
    return {
      title: "Open a supported streaming episode",
      body: "Room controls appear when the active tab is on a supported watch page.",
    };
  }

  if (!state.providerReady && state.connectionState === "switching") {
    return {
      title: "Switching to the next episode",
      body: "Stay on this tab and the room will reconnect automatically.",
    };
  }

  if (!state.providerReady) {
    return {
      title: "Waiting for the player",
      body: "Open a supported episode page and let the video player finish loading.",
    };
  }

  if (state.connectionState === "connected") {
    return {
      title: state.episodeTitle ?? "Room connected",
      body: roomRoleLabel(state),
    };
  }

  if (state.connectionState === "connecting") {
    return {
      title: state.episodeTitle ?? "Connecting to room",
      body: "Joining the backend and restoring room state.",
    };
  }

  if (state.connectionState === "error") {
    return {
      title: state.episodeTitle ?? "Connection problem",
      body: state.lastError ?? "The room could not be reached.",
    };
  }

  return {
    title: state.episodeTitle ?? "Create a room for this episode",
    body: progressLabel(state),
  };
}

function canCreateRoom(state: PopupStateResponse) {
  return state.supported && state.providerReady && !state.roomId;
}

function canReconnectRoom(state: PopupStateResponse) {
  return (
    state.supported &&
    state.providerReady &&
    Boolean(state.roomId) &&
    state.connectionState !== "connected" &&
    state.connectionState !== "connecting" &&
    state.connectionState !== "switching"
  );
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

async function copyToClipboard(value: string, notice: string) {
  await navigator.clipboard.writeText(value);
  uiState.notice = notice;
}

function resolvePopupStateWaiters(state: PopupStateResponse | undefined) {
  const waiters = popupStateResolvers;
  popupStateResolvers = [];
  for (const waiter of waiters) {
    waiter(state);
  }
}

function queueRender() {
  if (renderQueued) {
    return;
  }

  renderQueued = true;
  window.setTimeout(() => {
    renderQueued = false;
    void render();
  }, 0);
}

function connectPopupStatePort() {
  if (popupStatePort) {
    return popupStatePort;
  }

  const port = browser.runtime.connect({ name: POPUP_STATE_PORT_NAME });
  popupStatePort = port;

  port.onMessage.addListener((response) => {
    livePopupState = response as PopupStateResponse;
    resolvePopupStateWaiters(livePopupState);
    applyThemeMode(livePopupState.themeMode);
    if (app) {
      queueRender();
    }
  });

  port.onDisconnect.addListener(() => {
    if (popupStatePort === port) {
      popupStatePort = undefined;
    }
    resolvePopupStateWaiters(livePopupState);
  });

  return port;
}

async function waitForLivePopupState(timeoutMs = 500) {
  connectPopupStatePort();

  if (livePopupState) {
    return livePopupState;
  }

  return new Promise<PopupStateResponse | undefined>((resolve) => {
    const waiter = (state: PopupStateResponse | undefined) => {
      window.clearTimeout(timeoutId);
      popupStateResolvers = popupStateResolvers.filter(
        (candidate) => candidate !== waiter,
      );
      resolve(state);
    };

    const timeoutId = window.setTimeout(() => {
      popupStateResolvers = popupStateResolvers.filter(
        (candidate) => candidate !== waiter,
      );
      resolve(undefined);
    }, timeoutMs);

    popupStateResolvers.push(waiter);
  });
}

async function createFallbackState(
  settings: ExtensionSettings,
  recentRooms: RecentRoomEntry[],
  lastError = "Extension state is still loading. Try again in a moment.",
): Promise<PopupStateResponse> {
  const activeTab = await getActiveTab().catch(() => undefined);
  const supported =
    typeof activeTab?.url === "string" && isCrunchyrollUrl(activeTab.url);

  return {
    activeTabId: activeTab?.id,
    activeTabUrl: activeTab?.url,
    supported,
    providerReady: false,
    connectionState: supported ? "ready" : "unsupported",
    participantCount: 0,
    backendHttpUrl: settings.backendHttpUrl,
    backendWsUrl: settings.backendWsUrl,
    recentRooms,
    themeMode: settings.themeMode,
    lastError,
    isHost: false,
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
    isHost: Boolean(state.isHost),
  };
}

async function loadViewModel(): Promise<PopupViewModel> {
  const [settings, recentRooms] = await Promise.all([
    getSettings().catch(() => DEFAULT_SETTINGS),
    listRecentRooms().catch(() => []),
  ]);

  const fallbackState = await createFallbackState(settings, recentRooms);
  const normalizedState = normalizePopupState(
    await waitForLivePopupState(),
    fallbackState,
  );
  applyThemeMode(normalizedState.themeMode);

  return {
    popupState: normalizedState,
    settings: {
      backendHttpUrl: normalizedState.backendHttpUrl,
      backendWsUrl: normalizedState.backendWsUrl,
      themeMode: normalizedState.themeMode,
    },
    recentRooms: normalizedState.recentRooms,
  };
}

function renderTabs(activeTab: PopupTab) {
  const tabs: PopupTab[] = ["home", "rooms", "settings"];
  return tabs
    .map(
      (tab) => `
        <button class="tab ${activeTab === tab ? "is-active" : ""}" data-tab="${tab}">
          ${TAB_LABELS[tab]}
        </button>
      `,
    )
    .join("");
}

function renderHome(view: PopupViewModel) {
  const { popupState } = view;
  const summary = describeHomeState(popupState);
  const shareUrl = popupState.shareUrl;

  return `
    <section class="panel hero-panel">
      <div class="eyebrow-row">
        <span class="eyebrow">Current Room</span>
        <span class="status-chip status-${popupState.connectionState}">${roomStatusLabel(popupState)}</span>
      </div>
      <h1>${summary.title}</h1>
      <p class="muted">${summary.body}</p>

      <div class="meta-grid">
        <div class="meta-card">
          <span class="meta-label">Participants</span>
          <strong>${popupState.roomId ? popupState.participantCount : 0}</strong>
        </div>
        <div class="meta-card">
          <span class="meta-label">Role</span>
          <strong>${popupState.roomId ? (popupState.isHost ? "Host" : "Viewer") : "None"}</strong>
        </div>
      </div>

      ${
        shareUrl
          ? `<label class="field">
              <span>Invite Link</span>
              <input class="share-input" readonly value="${shareUrl}" />
            </label>`
          : ""
      }

      <div class="action-row">
        ${
          canCreateRoom(popupState)
            ? `<button class="primary grow" data-action="create-room">Create Room</button>`
            : ""
        }
        ${
          canReconnectRoom(popupState)
            ? `<button class="primary grow" data-action="reconnect-room">Reconnect</button>`
            : ""
        }
        ${
          popupState.roomId
            ? `<button class="secondary" data-action="copy-room-link">Copy Link</button>
               <button class="secondary" data-action="leave-room">Leave Room</button>`
            : ""
        }
      </div>

      ${
        popupState.lastError && popupState.connectionState === "error"
          ? `<p class="notice error">${popupState.lastError}</p>`
          : `<p class="muted">Backend: ${popupState.backendWsUrl}</p>`
      }
    </section>
  `;
}

function renderRoomCard(room: RecentRoomEntry, expanded = false) {
  const title = room.label ?? room.episodeTitle;
  return `
    <article class="room-card ${expanded ? "room-card-wide" : ""}" data-room-id="${room.roomId}">
      <div class="room-card-head">
        <div>
          <strong>${title}</strong>
          ${room.label ? `<p class="muted">${room.episodeTitle}</p>` : ""}
        </div>
        <span class="room-pill">${room.roomId}</span>
      </div>
      <p class="muted clamp">${room.shareUrl}</p>
      <div class="inline-actions">
        <button class="secondary" data-room-open="${room.roomId}">Open</button>
        <button class="secondary" data-room-copy="${room.roomId}">Copy</button>
        <button class="secondary" data-room-rename="${room.roomId}">Rename</button>
        <button class="secondary danger" data-room-delete="${room.roomId}">Delete</button>
      </div>
      ${
        uiState.editingRoomId === room.roomId
          ? `<div class="edit-row">
              <input id="rename-room-input" value="${title}" />
              <button class="primary" data-room-save="${room.roomId}">Save</button>
              <button class="secondary" data-room-cancel>Cancel</button>
            </div>`
          : ""
      }
    </article>
  `;
}

function renderRooms(view: PopupViewModel) {
  const recent = view.recentRooms;
  const featuredRooms = recent.slice(0, 3);

  return `
    <section class="panel">
      <div class="section-head">
        <div>
          <h2>Recent Rooms</h2>
          <p class="muted">Local shortcuts for rooms you recently created or joined.</p>
        </div>
      </div>

      ${
        featuredRooms.length > 0
          ? `<div class="room-grid">${featuredRooms
              .map((room) => renderRoomCard(room))
              .join("")}</div>`
          : `<div class="empty-state">
              <strong>No rooms saved yet</strong>
              <p class="muted">Create or join a room and it will show up here for quick reopening.</p>
            </div>`
      }

      ${
        recent.length > 3
          ? `<div class="subsection">
              <div class="section-head compact">
                <h3>All Saved Rooms</h3>
              </div>
              <div class="room-list">${recent
                .map((room) => renderRoomCard(room, true))
                .join("")}</div>
            </div>`
          : ""
      }
    </section>
  `;
}

function renderSettings(view: PopupViewModel) {
  const { settings } = view;

  return `
    <section class="panel">
      <div class="section-head">
        <div>
          <h2>Settings</h2>
          <p class="muted">Switch backends, pick a theme, and keep the extension pointed at your own setup.</p>
        </div>
      </div>

      <label class="field">
        <span>HTTP Base URL</span>
        <input id="settings-http-url" value="${settings.backendHttpUrl}" />
      </label>

      <label class="field">
        <span>WebSocket URL</span>
        <input id="settings-ws-url" value="${settings.backendWsUrl}" />
      </label>

      <label class="field">
        <span>Theme</span>
        <select id="settings-theme-mode">
          ${(["system", "light", "dark"] as ThemeMode[])
            .map(
              (mode) => `
                <option value="${mode}" ${settings.themeMode === mode ? "selected" : ""}>
                  ${THEME_LABELS[mode]}
                </option>
              `,
            )
            .join("")}
        </select>
      </label>

      <div class="action-row">
        <button class="primary grow" data-action="save-settings">Save Settings</button>
        <button class="secondary" data-action="reset-settings">Restore Defaults</button>
      </div>

      <button class="link-button" data-action="open-options">
        Open full settings page
      </button>
    </section>
  `;
}

function renderShell(view: PopupViewModel) {
  if (!app) {
    return;
  }

  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div>
          <span class="eyebrow">Roll Together</span>
          <strong class="topbar-title">${
            view.popupState.roomId ? view.popupState.roomId : "Watch parties"
          }</strong>
        </div>
        ${
          uiState.notice
            ? `<span class="flash">${uiState.notice}</span>`
            : `<span class="topbar-muted">${view.popupState.supported ? "Supported tab" : "Waiting for a supported tab"}</span>`
        }
      </header>

      <nav class="tabs">${renderTabs(uiState.activeTab)}</nav>

      <main class="tab-panels">
        ${uiState.activeTab === "home" ? renderHome(view) : ""}
        ${uiState.activeTab === "rooms" ? renderRooms(view) : ""}
        ${uiState.activeTab === "settings" ? renderSettings(view) : ""}
      </main>
    </div>
  `;
}

async function render() {
  const view = await loadViewModel();
  renderShell(view);
  bindEvents(view);
}

function bindEvents(view: PopupViewModel) {
  if (!app) {
    return;
  }

  app.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((button) => {
    button.addEventListener("click", async () => {
      const nextTab = button.dataset.tab as PopupTab | undefined;
      if (!nextTab) {
        return;
      }

      uiState.activeTab = nextTab;
      uiState.notice = undefined;
      await render();
    });
  });

  app
    .querySelector<HTMLButtonElement>("[data-action='create-room']")
    ?.addEventListener("click", async () => {
      const activeTab = await getActiveTab();
      if (!activeTab?.id) {
        return;
      }

      const nextState = await sendPopupMessage<PopupStateResponse>({
        type: "popup:create-room",
        tabId: activeTab.id,
      });
      if (nextState) {
        livePopupState = nextState;
      }
      uiState.notice = "Room created.";
      await render();
    });

  app
    .querySelector<HTMLButtonElement>("[data-action='reconnect-room']")
    ?.addEventListener("click", async () => {
      const activeTab = await getActiveTab();
      if (!activeTab?.id) {
        return;
      }

      const nextState = await sendPopupMessage<PopupStateResponse>({
        type: "popup:create-room",
        tabId: activeTab.id,
      });
      if (nextState) {
        livePopupState = nextState;
      }
      uiState.notice = "Room reconnected.";
      await render();
    });

  app
    .querySelector<HTMLButtonElement>("[data-action='copy-room-link']")
    ?.addEventListener("click", async () => {
      if (!view.popupState.shareUrl) {
        return;
      }

      await copyToClipboard(view.popupState.shareUrl, "Room link copied.");
      await render();
    });

  app
    .querySelector<HTMLButtonElement>("[data-action='leave-room']")
    ?.addEventListener("click", async () => {
      const activeTab = await getActiveTab();
      if (!activeTab?.id) {
        return;
      }

      const nextState = await sendPopupMessage<PopupStateResponse>({
        type: "popup:disconnect-room",
        tabId: activeTab.id,
      });
      if (nextState) {
        livePopupState = nextState;
      }
      uiState.notice = "Left the room.";
      await render();
    });

  app
    .querySelector<HTMLButtonElement>("[data-action='save-settings']")
    ?.addEventListener("click", async () => {
      const nextSettings: ExtensionSettings = {
        backendHttpUrl:
          app
            .querySelector<HTMLInputElement>("#settings-http-url")
            ?.value.trim() ?? DEFAULT_SETTINGS.backendHttpUrl,
        backendWsUrl:
          app
            .querySelector<HTMLInputElement>("#settings-ws-url")
            ?.value.trim() ?? DEFAULT_SETTINGS.backendWsUrl,
        themeMode:
          (app.querySelector<HTMLSelectElement>("#settings-theme-mode")
            ?.value as ThemeMode | undefined) ?? DEFAULT_SETTINGS.themeMode,
      };

      await saveSettings(nextSettings);
      uiState.notice = "Settings saved.";
      applyThemeMode(nextSettings.themeMode);
      await render();
    });

  app
    .querySelector<HTMLButtonElement>("[data-action='reset-settings']")
    ?.addEventListener("click", async () => {
      await saveSettings(DEFAULT_SETTINGS);
      uiState.notice = "Defaults restored.";
      applyThemeMode(DEFAULT_SETTINGS.themeMode);
      await render();
    });

  app
    .querySelector<HTMLButtonElement>("[data-action='open-options']")
    ?.addEventListener("click", async () => {
      await browser.runtime.openOptionsPage();
    });

  app
    .querySelectorAll<HTMLButtonElement>("[data-room-open]")
    .forEach((button) => {
      button.addEventListener("click", async () => {
        const room = view.recentRooms.find(
          (entry) => entry.roomId === button.dataset.roomOpen,
        );
        if (!room) {
          return;
        }

        await browser.tabs.create({ url: room.shareUrl });
        uiState.notice = "Room opened in a new tab.";
        await render();
      });
    });

  app
    .querySelectorAll<HTMLButtonElement>("[data-room-copy]")
    .forEach((button) => {
      button.addEventListener("click", async () => {
        const room = view.recentRooms.find(
          (entry) => entry.roomId === button.dataset.roomCopy,
        );
        if (!room) {
          return;
        }

        await copyToClipboard(room.shareUrl, "Saved room link copied.");
        await render();
      });
    });

  app
    .querySelectorAll<HTMLButtonElement>("[data-room-rename]")
    .forEach((button) => {
      button.addEventListener("click", async () => {
        uiState.editingRoomId = button.dataset.roomRename;
        uiState.notice = undefined;
        await render();
      });
    });

  app
    .querySelectorAll<HTMLButtonElement>("[data-room-delete]")
    .forEach((button) => {
      button.addEventListener("click", async () => {
        const roomId = button.dataset.roomDelete;
        if (!roomId) {
          return;
        }

        await deleteRecentRoom(roomId);
        if (uiState.editingRoomId === roomId) {
          uiState.editingRoomId = undefined;
        }
        uiState.notice = "Saved room removed.";
        await render();
      });
    });

  app
    .querySelectorAll<HTMLButtonElement>("[data-room-save]")
    .forEach((button) => {
      button.addEventListener("click", async () => {
        const roomId = button.dataset.roomSave;
        const nextLabel =
          app.querySelector<HTMLInputElement>("#rename-room-input")?.value ??
          "";
        if (!roomId) {
          return;
        }

        await renameRecentRoom(roomId, nextLabel);
        uiState.editingRoomId = undefined;
        uiState.notice = "Room label updated.";
        await render();
      });
    });

  app
    .querySelector<HTMLButtonElement>("[data-room-cancel]")
    ?.addEventListener("click", async () => {
      uiState.editingRoomId = undefined;
      await render();
    });
}

void render();
