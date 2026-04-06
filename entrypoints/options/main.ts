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

  app.innerHTML = `
    <main>
      <section class="card header-card">
        <div>
          <span class="eyebrow">Roll Together</span>
          <h1>Settings</h1>
        </div>
        <p class="muted">${status}</p>
      </section>

      <section class="card">
        <div class="section-head">
          <div>
            <h2>Connection</h2>
            <p class="muted">Point the extension at any backend you want to use.</p>
          </div>
        </div>

        <label>
          HTTP Base URL
          <input id="httpUrl" value="${settings.backendHttpUrl}" />
        </label>

        <label>
          WebSocket URL
          <input id="wsUrl" value="${settings.backendWsUrl}" />
        </label>

        <label>
          Theme
          <select id="themeMode">
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

        <div class="actions">
          <button class="primary" id="saveSettings">Save Settings</button>
          <button class="secondary" id="resetSettings">Restore Defaults</button>
        </div>
      </section>

      <section class="card">
        <div class="section-head">
          <div>
            <h2>Saved Rooms</h2>
            <p class="muted">Rename, reopen, copy, or remove locally saved room shortcuts.</p>
          </div>
        </div>

        ${
          recentRooms.length > 0
            ? `<ul class="list">${recentRooms
                .map((room) => renderRoomItem(room))
                .join("")}</ul>`
            : `<p class="muted">No room history yet.</p>`
        }
      </section>

      <section class="card">
        <div class="section-head">
          <div>
            <h2>Watched Progress</h2>
            <p class="muted">Playback snapshots stay local to your browser profile.</p>
          </div>
        </div>
        ${
          watchProgress.length > 0
            ? `<ul class="list">${watchProgress
                .map((entry) => {
                  const durationLabel =
                    entry.durationSeconds === null
                      ? "Unknown duration"
                      : `${Math.floor(entry.progressSeconds / 60)}m / ${Math.floor(
                          entry.durationSeconds / 60,
                        )}m`;
                  return `<li><strong>${entry.episodeTitle}</strong><br /><span class="muted">${durationLabel}</span></li>`;
                })
                .join("")}</ul>`
            : `<p class="muted">Playback snapshots will be stored locally once you start using the extension.</p>`
        }
        <div class="actions">
          <button class="secondary" id="clearProgress">Clear Local History</button>
        </div>
      </section>
    </main>
  `;

  bindEvents();
}

function renderRoomItem(room: RecentRoomEntry) {
  const title = room.label ?? room.episodeTitle;

  return `
    <li class="room-item" data-room-id="${room.roomId}">
      <div class="room-item-head">
        <div>
          <strong>${title}</strong>
          ${room.label ? `<p class="muted">${room.episodeTitle}</p>` : ""}
        </div>
        <span class="room-pill">${room.roomId}</span>
      </div>
      <span class="muted clamp">${room.shareUrl}</span>
      <div class="actions">
        <button class="secondary" data-room-open="${room.roomId}">Open</button>
        <button class="secondary" data-room-copy="${room.roomId}">Copy</button>
        <button class="secondary" data-room-rename="${room.roomId}">Rename</button>
        <button class="secondary danger" data-room-delete="${room.roomId}">Delete</button>
      </div>
    </li>
  `;
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
