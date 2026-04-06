import "./style.css";

import { browser } from "../../src/platform/browser";
import {
  clearLocalProgress,
  DEFAULT_SETTINGS,
  deleteRecentRoom,
  getSettings,
  listRecentRooms,
  listWatchProgress,
  renameRecentRoom,
  saveSettings,
  type ExtensionSettings,
  type RecentRoomEntry,
  type ThemeMode,
} from "../../src/core/storage";
import { applyThemeMode } from "../../src/ui/theme";

const app = document.querySelector<HTMLDivElement>("#app");
const THEME_LABELS: Record<ThemeMode, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

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

function createSectionHead(title: string, description: string) {
  const head = createElement("div", { className: "section-head" });
  const copy = createElement("div");
  appendChildren(copy, [
    createElement("h2", { text: title }),
    createElement("p", { className: "muted", text: description }),
  ]);
  head.appendChild(copy);
  return head;
}

function createLabelledInput(
  labelText: string,
  id: string,
  value: string,
  type = "text",
) {
  const label = createElement("label");
  label.append(labelText);
  const input = createElement("input", { id, type }) as HTMLInputElement;
  input.value = value;
  label.appendChild(input);
  return label;
}

function createThemeSelect(themeMode: ThemeMode) {
  const label = createElement("label");
  label.append("Theme");
  const select = createElement("select", { id: "themeMode" });

  for (const mode of ["system", "light", "dark"] as ThemeMode[]) {
    const option = createElement("option", { text: THEME_LABELS[mode] });
    option.setAttribute("value", mode);
    option.selected = mode === themeMode;
    select.appendChild(option);
  }

  label.appendChild(select);
  return label;
}

function createButton(
  text: string,
  className: string,
  id?: string,
  dataset?: Record<string, string>,
) {
  const button = createElement("button", { className, text, id });
  button.setAttribute("type", "button");

  if (dataset) {
    for (const [key, value] of Object.entries(dataset)) {
      button.dataset[key] = value;
    }
  }

  return button;
}

function createRoomItem(room: RecentRoomEntry) {
  const title = room.label ?? room.episodeTitle;
  const item = createElement("li", { className: "room-item" });
  item.dataset.roomId = room.roomId;

  const head = createElement("div", { className: "room-item-head" });
  const copy = createElement("div");
  appendChildren(copy, [
    createElement("strong", { text: title }),
    room.label
      ? createElement("p", { className: "muted", text: room.episodeTitle })
      : undefined,
  ]);

  const pill = createElement("span", {
    className: "room-pill",
    text: room.roomId,
  });
  appendChildren(head, [copy, pill]);

  const url = createElement("span", { className: "muted clamp" });
  url.textContent = room.shareUrl;

  const actions = createElement("div", { className: "actions" });
  appendChildren(actions, [
    createButton("Open", "secondary", undefined, { roomOpen: room.roomId }),
    createButton("Copy", "secondary", undefined, { roomCopy: room.roomId }),
    createButton("Rename", "secondary", undefined, {
      roomRename: room.roomId,
    }),
    createButton("Delete", "secondary danger", undefined, {
      roomDelete: room.roomId,
    }),
  ]);

  appendChildren(item, [head, url, actions]);
  return item;
}

function createWatchProgressItem(title: string, durationLabel: string) {
  const item = createElement("li");
  appendChildren(item, [
    createElement("strong", { text: title }),
    createElement("span", { className: "muted", text: durationLabel }),
  ]);
  return item;
}

async function render(
  status = "Adjust backend settings, local history, and theme preferences here.",
) {
  if (!app) {
    return;
  }

  const settings = await getSettings();
  const recentRooms = await listRecentRooms();
  const watchProgress = await listWatchProgress();

  applyThemeMode(settings.themeMode);

  const main = createElement("main");

  const headerCard = createElement("section", {
    className: "card header-card",
  });
  const headerCopy = createElement("div");
  appendChildren(headerCopy, [
    createElement("span", { className: "eyebrow", text: "Roll Together" }),
    createElement("h1", { text: "Settings" }),
  ]);
  appendChildren(headerCard, [
    headerCopy,
    createElement("p", { className: "muted", text: status }),
  ]);

  const connectionCard = createElement("section", { className: "card" });
  const connectionActions = createElement("div", { className: "actions" });
  appendChildren(connectionActions, [
    createButton("Save Settings", "primary", "saveSettings"),
    createButton("Restore Defaults", "secondary", "resetSettings"),
  ]);
  appendChildren(connectionCard, [
    createSectionHead(
      "Connection",
      "Point the extension at any backend you want to use.",
    ),
    createLabelledInput("HTTP Base URL", "httpUrl", settings.backendHttpUrl),
    createLabelledInput("WebSocket URL", "wsUrl", settings.backendWsUrl),
    createThemeSelect(settings.themeMode),
    connectionActions,
  ]);

  const roomsCard = createElement("section", { className: "card" });
  appendChildren(roomsCard, [
    createSectionHead(
      "Saved Rooms",
      "Rename, reopen, copy, or remove locally saved room shortcuts.",
    ),
  ]);

  if (recentRooms.length > 0) {
    const list = createElement("ul", { className: "list" });
    for (const room of recentRooms) {
      list.appendChild(createRoomItem(room));
    }
    roomsCard.appendChild(list);
  } else {
    roomsCard.appendChild(
      createElement("p", { className: "muted", text: "No room history yet." }),
    );
  }

  const progressCard = createElement("section", { className: "card" });
  appendChildren(progressCard, [
    createSectionHead(
      "Watched Progress",
      "Playback snapshots stay local to your browser profile.",
    ),
  ]);

  if (watchProgress.length > 0) {
    const list = createElement("ul", { className: "list" });
    for (const entry of watchProgress) {
      const durationLabel =
        entry.durationSeconds === null
          ? "Unknown duration"
          : `${Math.floor(entry.progressSeconds / 60)}m / ${Math.floor(
              entry.durationSeconds / 60,
            )}m`;
      list.appendChild(
        createWatchProgressItem(entry.episodeTitle, durationLabel),
      );
    }
    progressCard.appendChild(list);
  } else {
    progressCard.appendChild(
      createElement("p", {
        className: "muted",
        text: "Playback snapshots will be stored locally once you start using the extension.",
      }),
    );
  }

  const progressActions = createElement("div", { className: "actions" });
  progressActions.appendChild(
    createButton("Clear Local History", "secondary", "clearProgress"),
  );
  progressCard.appendChild(progressActions);

  appendChildren(main, [headerCard, connectionCard, roomsCard, progressCard]);
  app.replaceChildren(main);

  bindEvents();
}

function bindEvents() {
  app
    ?.querySelector<HTMLButtonElement>("#saveSettings")
    ?.addEventListener("click", async () => {
      const nextSettings: ExtensionSettings = {
        backendHttpUrl:
          app?.querySelector<HTMLInputElement>("#httpUrl")?.value.trim() ??
          DEFAULT_SETTINGS.backendHttpUrl,
        backendWsUrl:
          app?.querySelector<HTMLInputElement>("#wsUrl")?.value.trim() ??
          DEFAULT_SETTINGS.backendWsUrl,
        themeMode:
          (app?.querySelector<HTMLSelectElement>("#themeMode")?.value as
            | ThemeMode
            | undefined) ?? DEFAULT_SETTINGS.themeMode,
      };

      await saveSettings(nextSettings);
      await render("Saved extension settings.");
    });

  app
    ?.querySelector<HTMLButtonElement>("#resetSettings")
    ?.addEventListener("click", async () => {
      await saveSettings(DEFAULT_SETTINGS);
      await render("Restored the default backend URLs and theme.");
    });

  app
    ?.querySelector<HTMLButtonElement>("#clearProgress")
    ?.addEventListener("click", async () => {
      await clearLocalProgress();
      await render("Cleared local room history and watched progress.");
    });

  app
    ?.querySelectorAll<HTMLButtonElement>("[data-room-open]")
    .forEach((button) => {
      button.addEventListener("click", async () => {
        const room = await findRoom(button.dataset.roomOpen);
        if (!room) {
          return;
        }

        await browser.tabs.create({ url: room.shareUrl });
      });
    });

  app
    ?.querySelectorAll<HTMLButtonElement>("[data-room-copy]")
    .forEach((button) => {
      button.addEventListener("click", async () => {
        const room = await findRoom(button.dataset.roomCopy);
        if (!room) {
          return;
        }

        await navigator.clipboard.writeText(room.shareUrl);
        await render("Copied the saved room link.");
      });
    });

  app
    ?.querySelectorAll<HTMLButtonElement>("[data-room-rename]")
    .forEach((button) => {
      button.addEventListener("click", async () => {
        const room = await findRoom(button.dataset.roomRename);
        if (!room) {
          return;
        }

        const nextLabel = window.prompt(
          "Rename this saved room",
          room.label ?? room.episodeTitle,
        );
        if (nextLabel === null) {
          return;
        }

        await renameRecentRoom(room.roomId, nextLabel);
        await render("Updated the saved room label.");
      });
    });

  app
    ?.querySelectorAll<HTMLButtonElement>("[data-room-delete]")
    .forEach((button) => {
      button.addEventListener("click", async () => {
        const roomId = button.dataset.roomDelete;
        if (!roomId) {
          return;
        }

        await deleteRecentRoom(roomId);
        await render("Removed the saved room.");
      });
    });
}

async function findRoom(roomId: string | undefined) {
  if (!roomId) {
    return undefined;
  }

  const recentRooms = await listRecentRooms();
  return recentRooms.find((room) => room.roomId === roomId);
}

void render();
