import "./style.css";

import {
  clearLocalProgress,
  DEFAULT_SETTINGS,
  getSettings,
  listRecentRooms,
  listWatchProgress,
  resetSettings,
  saveSettings,
  type ExtensionSettings,
} from "../../src/core/storage";

const app = document.querySelector<HTMLDivElement>("#app");

async function render(
  status = "Self-hosting defaults keep the local dev flow simple.",
) {
  if (!app) {
    return;
  }

  const settings = await getSettings();
  const recentRooms = await listRecentRooms();
  const watchProgress = await listWatchProgress();

  app.innerHTML = `
    <main>
      <section class="card">
        <h1>Roll Together v2 Settings</h1>
        <p class="muted">Keep the browser extension anonymous, point it at your own backend, and track watch history locally.</p>
      </section>

      <section class="card">
        <h2>Backend</h2>
        <label>
          HTTP Base URL
          <input id="httpUrl" value="${settings.backendHttpUrl}" />
        </label>
        <label>
          WebSocket URL
          <input id="wsUrl" value="${settings.backendWsUrl}" />
        </label>
        <div class="actions">
          <button class="primary" id="saveSettings">Save Settings</button>
          <button class="secondary" id="resetSettings">Restore Defaults</button>
        </div>
        <p class="muted">${status}</p>
      </section>

      <section class="card">
        <h2>Recent Rooms</h2>
        ${
          recentRooms.length > 0
            ? `<ul class="list">${recentRooms
                .map(
                  (room) =>
                    `<li><strong>${room.episodeTitle}</strong><br /><span class="muted">${room.shareUrl}</span></li>`,
                )
                .join("")}</ul>`
            : `<p class="muted">No room history yet.</p>`
        }
      </section>

      <section class="card">
        <h2>Watched Progress</h2>
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

  app
    .querySelector<HTMLButtonElement>("#saveSettings")
    ?.addEventListener("click", async () => {
      const nextSettings: ExtensionSettings = {
        backendHttpUrl:
          app.querySelector<HTMLInputElement>("#httpUrl")?.value.trim() ??
          DEFAULT_SETTINGS.backendHttpUrl,
        backendWsUrl:
          app.querySelector<HTMLInputElement>("#wsUrl")?.value.trim() ??
          DEFAULT_SETTINGS.backendWsUrl,
      };

      await saveSettings(nextSettings);
      await render("Saved backend settings.");
    });

  app
    .querySelector<HTMLButtonElement>("#resetSettings")
    ?.addEventListener("click", async () => {
      await resetSettings();
      await render("Restored the default local backend URLs.");
    });

  app
    .querySelector<HTMLButtonElement>("#clearProgress")
    ?.addEventListener("click", async () => {
      await clearLocalProgress();
      await render("Cleared local room history and watched progress.");
    });
}

void render();
