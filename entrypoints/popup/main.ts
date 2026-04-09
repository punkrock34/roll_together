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
import { testBackendConnection } from "../../src/core/backend-test";
import type {
  PopupRequestMessage,
  PopupStateResponse,
} from "../../src/core/messages";
import type {
  ParticipantPresence,
  RoomControlMode,
} from "../../src/core/protocol";
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
const ROOM_CONTROL_MODE_LABELS: Record<RoomControlMode, string> = {
  host_only: "Host only",
  shared_playback: "Shared playback",
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

function createElement<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  options: {
    className?: string;
    text?: string;
    id?: string;
    type?: string;
  } = {},
) {
  const element = document.createElement(tagName);

  if (options.className) {
    element.className = options.className;
  }

  if (options.text !== undefined) {
    element.textContent = options.text;
  }

  if (options.id) {
    element.id = options.id;
  }

  if ("type" in element && options.type) {
    (element as HTMLInputElement).type = options.type;
  }

  return element;
}

function appendChildren(parent: Node, children: Array<Node | undefined>) {
  for (const child of children) {
    if (child) {
      parent.appendChild(child);
    }
  }
}

function createButton(
  text: string,
  className: string,
  options: {
    action?: string;
    tab?: PopupTab;
    roomIdKey?:
      | "roomOpen"
      | "roomCopy"
      | "roomRename"
      | "roomDelete"
      | "roomSave";
    roomId?: string;
    id?: string;
  } = {},
) {
  const button = createElement("button", {
    className,
    text,
    id: options.id,
  });
  button.setAttribute("type", "button");

  if (options.action) {
    button.dataset.action = options.action;
  }

  if (options.tab) {
    button.dataset.tab = options.tab;
  }

  if (options.roomIdKey && options.roomId) {
    button.dataset[options.roomIdKey] = options.roomId;
  }

  return button;
}

function roomStatusLabel(state: PopupStateResponse) {
  if (!state.supported) {
    return "Unsupported";
  }

  switch (state.connectionState) {
    case "connected":
      return "Connected";
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

  const role = state.isHost ? "Host" : "Viewer";
  return `${role} · ${ROOM_CONTROL_MODE_LABELS[state.controlMode]}`;
}

function participantDisplayName(
  participant: ParticipantPresence,
  currentSessionId: string | undefined,
) {
  const baseName = participant.displayName?.trim() || "Guest";
  if (participant.sessionId === currentSessionId) {
    return `${baseName} (You)`;
  }

  return baseName;
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
      title: "Room is live",
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

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (changes.settings?.newValue && livePopupState) {
    const nextSettings = changes.settings.newValue as ExtensionSettings;
    livePopupState = {
      ...livePopupState,
      backendHttpUrl: nextSettings.backendHttpUrl,
      backendWsUrl: nextSettings.backendWsUrl,
      displayName: nextSettings.displayName,
      themeMode: nextSettings.themeMode,
    };
    applyThemeMode(nextSettings.themeMode);
  }

  if (changes.recentRooms?.newValue && livePopupState) {
    livePopupState = {
      ...livePopupState,
      recentRooms: Array.isArray(changes.recentRooms.newValue)
        ? (changes.recentRooms.newValue as RecentRoomEntry[])
        : livePopupState.recentRooms,
    };
  }

  if (changes.settings || changes.recentRooms) {
    queueRender();
  }
});

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
    participants: [],
    backendHttpUrl: settings.backendHttpUrl,
    backendWsUrl: settings.backendWsUrl,
    displayName: settings.displayName,
    recentRooms,
    themeMode: settings.themeMode,
    lastError,
    isHost: false,
    controlMode: "shared_playback",
    canControlPlayback: false,
    canNavigateEpisodes: false,
    canTransferHost: false,
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
    controlMode:
      state.controlMode === "shared_playback"
        ? state.controlMode
        : "shared_playback",
    canControlPlayback: Boolean(state.canControlPlayback),
    canNavigateEpisodes: Boolean(state.canNavigateEpisodes),
    canTransferHost: Boolean(state.canTransferHost),
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
  const syncedState: PopupStateResponse = {
    ...normalizedState,
    backendHttpUrl: settings.backendHttpUrl,
    backendWsUrl: settings.backendWsUrl,
    displayName: settings.displayName,
    recentRooms,
    themeMode: settings.themeMode,
    participants: normalizedState.participants ?? [],
  };
  applyThemeMode(syncedState.themeMode);

  return {
    popupState: syncedState,
    settings,
    recentRooms,
  };
}

function createTopbar(view: PopupViewModel) {
  const topbar = createElement("header", { className: "topbar" });
  const left = createElement("div");
  const roomLabel = view.popupState.roomId
    ? `Room ${view.popupState.roomId}`
    : "No active room";
  const title = view.popupState.episodeTitle ?? "Watch Party Controls";
  appendChildren(left, [
    createElement("span", { className: "eyebrow", text: roomLabel }),
    createElement("strong", {
      className: "topbar-title",
      text: title,
    }),
  ]);

  const right = uiState.notice
    ? createElement("span", { className: "flash", text: uiState.notice })
    : createElement("span", {
        className: "topbar-muted",
        text: view.popupState.supported
          ? "Supported tab"
          : "Waiting for a supported tab",
      });

  appendChildren(topbar, [left, right]);
  return topbar;
}

function createTabs(activeTab: PopupTab) {
  const nav = createElement("nav", { className: "tabs" });

  for (const tab of ["home", "rooms", "settings"] as PopupTab[]) {
    nav.appendChild(
      createButton(
        TAB_LABELS[tab],
        `tab ${activeTab === tab ? "is-active" : ""}`.trim(),
        { tab },
      ),
    );
  }

  return nav;
}

function createField(labelText: string, input: HTMLElement) {
  const label = createElement("label", { className: "field" });
  label.appendChild(createElement("span", { text: labelText }));
  label.appendChild(input);
  return label;
}

function createMetaCard(label: string, value: string) {
  const card = createElement("div", { className: "meta-card" });
  appendChildren(card, [
    createElement("span", { className: "meta-label", text: label }),
    createElement("strong", { text: value }),
  ]);
  return card;
}

function createInviteLinkSection(shareUrl: string) {
  const section = createElement("div", { className: "invite-section" });
  const label = createElement("p", { className: "muted", text: "Invite Link" });
  const row = createElement("div", { className: "invite-row" });
  const input = createElement("input", {
    className: "share-input",
    type: "text",
    id: "room-share-url",
  }) as HTMLInputElement;
  input.readOnly = true;
  input.value = shareUrl;

  const copyButton = createButton("", "icon-copy-button", {
    action: "copy-room-link-inline",
  });
  copyButton.setAttribute("aria-label", "Copy invite link");
  copyButton.title = "Copy invite link";
  copyButton.appendChild(createElement("span", { className: "copy-icon" }));

  appendChildren(row, [input, copyButton]);
  appendChildren(section, [label, row]);
  return section;
}

function createParticipantsPanel(view: PopupViewModel) {
  const { popupState } = view;
  if (!popupState.roomId || popupState.participants.length === 0) {
    return undefined;
  }

  const section = createElement("div", { className: "participants-panel" });
  const head = createElement("div", { className: "section-head compact" });
  appendChildren(head, [
    createElement("h3", { text: "Participants" }),
    createElement("span", {
      className: "muted",
      text: `${popupState.participants.length}`,
    }),
  ]);

  const list = createElement("div", { className: "participant-list" });
  for (const participant of popupState.participants) {
    const item = createElement("div", { className: "participant-item" });
    const copy = createElement("div", { className: "participant-copy" });
    appendChildren(copy, [
      createElement("strong", {
        text: participantDisplayName(participant, popupState.sessionId),
      }),
      createElement("p", {
        className: "muted",
        text: participant.isHost ? "Host" : "Viewer",
      }),
    ]);

    const controls = createElement("div", {
      className: "participant-controls",
    });
    controls.appendChild(
      createElement("span", {
        className: "room-pill",
        text: "In room",
      }),
    );

    if (participant.isHost) {
      controls.appendChild(
        createElement("span", {
          className: "room-pill participant-host",
          text: "Host",
        }),
      );
    }

    if (
      popupState.canTransferHost &&
      participant.sessionId !== popupState.sessionId &&
      participant.connected
    ) {
      const transferButton = createButton("Make Host", "secondary", {
        action: "transfer-host",
      });
      transferButton.dataset.targetSessionId = participant.sessionId;
      controls.appendChild(transferButton);
    }

    appendChildren(item, [copy, controls]);
    list.appendChild(item);
  }

  appendChildren(section, [head, list]);
  return section;
}

function createHomePanel(view: PopupViewModel) {
  const { popupState } = view;
  const summary = describeHomeState(popupState);
  const panel = createElement("section", { className: "panel hero-panel" });

  const eyebrowRow = createElement("div", { className: "eyebrow-row" });
  appendChildren(eyebrowRow, [
    createElement("span", { className: "eyebrow", text: "Current Room" }),
    createElement("span", {
      className: `status-chip status-${popupState.connectionState}`,
      text: roomStatusLabel(popupState),
    }),
  ]);

  const metaGrid = createElement("div", { className: "meta-grid" });
  appendChildren(metaGrid, [
    createMetaCard(
      "Participants",
      `${popupState.roomId ? popupState.participantCount : 0}`,
    ),
    createMetaCard("Role", roomRoleLabel(popupState)),
  ]);

  let modeControlField: HTMLElement | undefined;
  if (popupState.roomId && popupState.canTransferHost) {
    const modeSelect = createElement("select", {
      id: "room-control-mode",
    }) as HTMLSelectElement;
    for (const mode of ["host_only", "shared_playback"] as RoomControlMode[]) {
      const option = createElement("option", {
        text: ROOM_CONTROL_MODE_LABELS[mode],
      }) as HTMLOptionElement;
      option.value = mode;
      option.selected = popupState.controlMode === mode;
      modeSelect.appendChild(option);
    }

    const wrapper = createElement("div", { className: "mode-control" });
    const modeField = createField("Room Control Mode", modeSelect);
    modeField.classList.add("mode-select-field");
    const applyButton = createButton("Apply", "secondary mode-apply-button", {
      action: "set-room-control-mode",
    });
    appendChildren(wrapper, [modeField, applyButton]);
    modeControlField = wrapper;
  }

  const actionRow = createElement("div", { className: "action-row" });
  if (canCreateRoom(popupState)) {
    actionRow.appendChild(
      createButton("Create Room", "primary grow", { action: "create-room" }),
    );
  }
  if (canReconnectRoom(popupState)) {
    actionRow.appendChild(
      createButton("Reconnect", "primary grow", { action: "reconnect-room" }),
    );
  }
  actionRow.classList.add("hero-actions");
  const heroActions = actionRow.childElementCount > 0 ? actionRow : undefined;

  let inviteSection: HTMLElement | undefined;
  if (popupState.shareUrl) {
    inviteSection = createInviteLinkSection(popupState.shareUrl);
  }

  let dangerZone: HTMLElement | undefined;
  if (popupState.roomId) {
    dangerZone = createElement("div", { className: "danger-zone" });
    appendChildren(dangerZone, [
      createElement("p", {
        className: "muted",
        text: "Need to stop syncing? You can leave this room.",
      }),
      createButton("Leave Room", "danger-fill", { action: "leave-room" }),
    ]);
  }

  appendChildren(panel, [
    eyebrowRow,
    createElement("h1", { text: summary.title }),
    createElement("p", { className: "muted", text: summary.body }),
    heroActions,
    metaGrid,
    modeControlField,
    createParticipantsPanel(view),
    inviteSection,
    dangerZone,
  ]);

  if (popupState.lastError && popupState.connectionState === "error") {
    panel.appendChild(
      createElement("p", {
        className: "notice error",
        text: popupState.lastError,
      }),
    );
  } else {
    panel.appendChild(
      createElement("p", {
        className: "muted",
        text: `Backend: ${popupState.backendWsUrl}`,
      }),
    );
  }

  return panel;
}

function createRoomCard(room: RecentRoomEntry, expanded = false) {
  const title = room.label ?? room.episodeTitle;
  const card = createElement("article", {
    className: `room-card ${expanded ? "room-card-wide" : ""}`.trim(),
  });
  card.dataset.roomId = room.roomId;

  const head = createElement("div", { className: "room-card-head" });
  const copy = createElement("div");
  appendChildren(copy, [
    createElement("strong", { text: title }),
    room.label
      ? createElement("p", { className: "muted", text: room.episodeTitle })
      : undefined,
  ]);

  appendChildren(head, [
    copy,
    createElement("span", { className: "room-pill", text: room.roomId }),
  ]);

  const url = createElement("p", { className: "muted clamp" });
  url.textContent = room.shareUrl;

  const actions = createElement("div", { className: "inline-actions" });
  appendChildren(actions, [
    createButton("Open", "secondary", {
      roomIdKey: "roomOpen",
      roomId: room.roomId,
    }),
    createButton("Copy", "secondary", {
      roomIdKey: "roomCopy",
      roomId: room.roomId,
    }),
    createButton("Rename", "secondary", {
      roomIdKey: "roomRename",
      roomId: room.roomId,
    }),
    createButton("Delete", "secondary danger", {
      roomIdKey: "roomDelete",
      roomId: room.roomId,
    }),
  ]);

  appendChildren(card, [head, url, actions]);

  if (uiState.editingRoomId === room.roomId) {
    const editRow = createElement("div", { className: "edit-row" });
    const input = createElement("input", {
      id: "rename-room-input",
      type: "text",
    }) as HTMLInputElement;
    input.value = title;

    appendChildren(editRow, [
      input,
      createButton("Save", "primary", {
        action: "save-room",
        roomIdKey: "roomSave",
      }),
      createButton("Cancel", "secondary", { action: "cancel-room-rename" }),
    ]);

    const saveButton = editRow.querySelector<HTMLButtonElement>(
      "[data-action='save-room']",
    );
    if (saveButton) {
      saveButton.dataset.roomSave = room.roomId;
    }

    card.appendChild(editRow);
  }

  return card;
}

function createRoomsPanel(view: PopupViewModel) {
  const recent = view.recentRooms;
  const featuredRooms = recent.slice(0, 3);
  const panel = createElement("section", { className: "panel" });

  const head = createElement("div", { className: "section-head" });
  const copy = createElement("div");
  appendChildren(copy, [
    createElement("h2", { text: "Recent Rooms" }),
    createElement("p", {
      className: "muted",
      text: "Local shortcuts for rooms you recently created or joined.",
    }),
  ]);
  head.appendChild(copy);
  panel.appendChild(head);

  if (featuredRooms.length > 0) {
    const grid = createElement("div", { className: "room-grid" });
    for (const room of featuredRooms) {
      grid.appendChild(createRoomCard(room));
    }
    panel.appendChild(grid);
  } else {
    const empty = createElement("div", { className: "empty-state" });
    appendChildren(empty, [
      createElement("strong", { text: "No rooms saved yet" }),
      createElement("p", {
        className: "muted",
        text: "Create or join a room and it will show up here for quick reopening.",
      }),
    ]);
    panel.appendChild(empty);
  }

  if (recent.length > 3) {
    const subsection = createElement("div", { className: "subsection" });
    const compactHead = createElement("div", {
      className: "section-head compact",
    });
    compactHead.appendChild(createElement("h3", { text: "All Saved Rooms" }));

    const list = createElement("div", { className: "room-list" });
    for (const room of recent) {
      list.appendChild(createRoomCard(room, true));
    }

    appendChildren(subsection, [compactHead, list]);
    panel.appendChild(subsection);
  }

  return panel;
}

function createSettingsPanel(view: PopupViewModel) {
  const { settings } = view;
  const panel = createElement("section", { className: "panel" });
  const head = createElement("div", { className: "section-head" });
  const copy = createElement("div");
  appendChildren(copy, [
    createElement("h2", { text: "Settings" }),
    createElement("p", {
      className: "muted",
      text: "Switch backends, pick a theme, and keep the extension pointed at your own setup.",
    }),
  ]);
  head.appendChild(copy);

  const httpInput = createElement("input", {
    id: "settings-http-url",
    type: "text",
  }) as HTMLInputElement;
  httpInput.value = settings.backendHttpUrl;

  const displayNameInput = createElement("input", {
    id: "settings-display-name",
    type: "text",
  }) as HTMLInputElement;
  displayNameInput.value = settings.displayName;

  const wsInput = createElement("input", {
    id: "settings-ws-url",
    type: "text",
  }) as HTMLInputElement;
  wsInput.value = settings.backendWsUrl;

  const select = createElement("select", {
    id: "settings-theme-mode",
  }) as HTMLSelectElement;
  for (const mode of ["system", "light", "dark"] as ThemeMode[]) {
    const option = createElement("option", { text: THEME_LABELS[mode] });
    option.value = mode;
    option.selected = settings.themeMode === mode;
    select.appendChild(option);
  }

  const actionRow = createElement("div", { className: "action-row" });
  appendChildren(actionRow, [
    createButton("Save Settings", "primary grow", { action: "save-settings" }),
    createButton("Test Connection", "secondary", {
      action: "test-settings-connection",
    }),
    createButton("Restore Defaults", "secondary", {
      action: "reset-settings",
    }),
  ]);
  const connectionStatus = createElement("p", {
    className: "connection-status",
    id: "settings-connection-status",
    text: "Use Test Connection to check the current HTTP and WebSocket URLs before saving.",
  });

  appendChildren(panel, [
    head,
    createField("Display Name", displayNameInput),
    createField("HTTP Base URL", httpInput),
    createField("WebSocket URL", wsInput),
    createField("Theme", select),
    actionRow,
    connectionStatus,
    createButton("Open full settings page", "link-button", {
      action: "open-options",
    }),
  ]);

  return panel;
}

function renderShell(view: PopupViewModel) {
  if (!app) {
    return;
  }

  const shell = createElement("div", { className: "shell" });
  const panels = createElement("main", { className: "tab-panels" });

  appendChildren(shell, [createTopbar(view), createTabs(uiState.activeTab)]);

  if (uiState.activeTab === "home") {
    panels.appendChild(createHomePanel(view));
  }
  if (uiState.activeTab === "rooms") {
    panels.appendChild(createRoomsPanel(view));
  }
  if (uiState.activeTab === "settings") {
    panels.appendChild(createSettingsPanel(view));
  }

  shell.appendChild(panels);
  app.replaceChildren(shell);
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

  const setSettingsConnectionStatus = (
    message: string,
    state: "idle" | "pending" | "success" | "error",
  ) => {
    const status = app.querySelector<HTMLParagraphElement>(
      "#settings-connection-status",
    );
    if (!status) {
      return;
    }

    status.textContent = message;
    status.className = `connection-status is-${state}`;
  };

  const readDraftBackendSettings = () => {
    return {
      backendHttpUrl:
        app
          .querySelector<HTMLInputElement>("#settings-http-url")
          ?.value.trim() ?? DEFAULT_SETTINGS.backendHttpUrl,
      backendWsUrl:
        app.querySelector<HTMLInputElement>("#settings-ws-url")?.value.trim() ??
        DEFAULT_SETTINGS.backendWsUrl,
    };
  };

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

      if (nextState?.shareUrl) {
        try {
          await copyToClipboard(
            nextState.shareUrl,
            "Room created and link copied.",
          );
        } catch {
          uiState.notice = "Room created. Copy failed, use the copy button.";
        }
      } else {
        uiState.notice = "Room created.";
      }
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
    .querySelector<HTMLButtonElement>("[data-action='copy-room-link-inline']")
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
    .querySelector<HTMLButtonElement>("[data-action='set-room-control-mode']")
    ?.addEventListener("click", async () => {
      const activeTab = await getActiveTab();
      if (!activeTab?.id) {
        return;
      }

      const mode = app.querySelector<HTMLSelectElement>("#room-control-mode")
        ?.value as RoomControlMode | undefined;
      if (mode !== "host_only" && mode !== "shared_playback") {
        return;
      }

      const nextState = await sendPopupMessage<PopupStateResponse>({
        type: "popup:set-room-control-mode",
        tabId: activeTab.id,
        controlMode: mode,
      });
      if (nextState) {
        livePopupState = nextState;
      }
      uiState.notice = "Room control mode updated.";
      await render();
    });

  app
    .querySelectorAll<HTMLButtonElement>("[data-action='transfer-host']")
    .forEach((button) => {
      button.addEventListener("click", async () => {
        const activeTab = await getActiveTab();
        const targetSessionId = button.dataset.targetSessionId;
        if (!activeTab?.id || !targetSessionId) {
          return;
        }

        const nextState = await sendPopupMessage<PopupStateResponse>({
          type: "popup:transfer-host",
          tabId: activeTab.id,
          targetSessionId,
        });
        if (nextState) {
          livePopupState = nextState;
        }
        uiState.notice = "Host transferred.";
        await render();
      });
    });

  app
    .querySelector<HTMLButtonElement>("[data-action='save-settings']")
    ?.addEventListener("click", async () => {
      const nextSettings: ExtensionSettings = {
        displayName:
          app
            .querySelector<HTMLInputElement>("#settings-display-name")
            ?.value.trim() ?? DEFAULT_SETTINGS.displayName,
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
      livePopupState = livePopupState
        ? {
            ...livePopupState,
            backendHttpUrl: nextSettings.backendHttpUrl,
            backendWsUrl: nextSettings.backendWsUrl,
            displayName: nextSettings.displayName,
            themeMode: nextSettings.themeMode,
          }
        : livePopupState;
      uiState.notice = "Settings saved.";
      applyThemeMode(nextSettings.themeMode);
      await render();
    });

  app
    .querySelector<HTMLButtonElement>(
      "[data-action='test-settings-connection']",
    )
    ?.addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      const { backendHttpUrl, backendWsUrl } = readDraftBackendSettings();

      button.disabled = true;
      setSettingsConnectionStatus(
        "Testing the health endpoint and WebSocket URL...",
        "pending",
      );

      try {
        const result = await testBackendConnection(
          backendHttpUrl,
          backendWsUrl,
        );
        setSettingsConnectionStatus(
          `${result.summary} ${result.health.message} ${result.websocket.message}`,
          result.ok ? "success" : "error",
        );
      } finally {
        button.disabled = false;
      }
    });

  app
    .querySelector<HTMLButtonElement>("[data-action='reset-settings']")
    ?.addEventListener("click", async () => {
      await saveSettings(DEFAULT_SETTINGS);
      livePopupState = livePopupState
        ? {
            ...livePopupState,
            backendHttpUrl: DEFAULT_SETTINGS.backendHttpUrl,
            backendWsUrl: DEFAULT_SETTINGS.backendWsUrl,
            displayName: DEFAULT_SETTINGS.displayName,
            themeMode: DEFAULT_SETTINGS.themeMode,
          }
        : livePopupState;
      uiState.notice = "Defaults restored.";
      applyThemeMode(DEFAULT_SETTINGS.themeMode);
      await render();
    });

  app
    .querySelector<HTMLSelectElement>("#settings-theme-mode")
    ?.addEventListener("change", (event) => {
      const nextTheme = (event.currentTarget as HTMLSelectElement)
        .value as ThemeMode;
      applyThemeMode(nextTheme);
    });

  app
    .querySelector<HTMLButtonElement>("[data-action='open-options']")
    ?.addEventListener("click", async () => {
      await browser.tabs.create({
        url: browser.runtime.getURL("/options.html"),
      });
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
    .querySelector<HTMLButtonElement>("[data-action='cancel-room-rename']")
    ?.addEventListener("click", async () => {
      uiState.editingRoomId = undefined;
      await render();
    });
}

void render();
