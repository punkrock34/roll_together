import { browser } from "wxt/browser";

import { normalizeBackendWsUrl } from "./network-url";
import type { ProviderName } from "./protocol";
import type { PlaybackSnapshot } from "./protocol";
import { toWatchProgressEntry } from "./watch-progress";

export type ThemeMode = "system" | "light" | "dark";

export interface ExtensionSettings {
  backendHttpUrl: string;
  backendWsUrl: string;
  themeMode: ThemeMode;
  displayName: string;
}

export interface RecentRoomEntry {
  roomId: string;
  shareUrl: string;
  episodeTitle: string;
  episodeUrl: string;
  updatedAt: number;
  label?: string;
}

export interface WatchProgressEntry {
  episodeUrl: string;
  episodeTitle: string;
  provider: ProviderName;
  progressSeconds: number;
  durationSeconds: number | null;
  updatedAt: number;
  completed: boolean;
}

interface ExtensionLocalState {
  settings: ExtensionSettings;
  recentRooms: RecentRoomEntry[];
  watchProgress: Record<string, WatchProgressEntry>;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  backendHttpUrl:
    import.meta.env.WXT_PUBLIC_BACKEND_HTTP_URL ?? "http://localhost:3000",
  backendWsUrl: normalizeBackendWsUrl(
    import.meta.env.WXT_PUBLIC_BACKEND_WS_URL ?? "ws://localhost:3000/ws",
  ),
  themeMode: "system",
  displayName: "Guest",
};

const DEFAULT_STATE: ExtensionLocalState = {
  settings: DEFAULT_SETTINGS,
  recentRooms: [],
  watchProgress: {},
};

const MAX_RECENT_ROOMS = 10;
const MAX_WATCHED_ITEMS = 30;

async function getState(): Promise<ExtensionLocalState> {
  const stored = (await browser.storage.local.get(
    DEFAULT_STATE as unknown as Record<string, unknown>,
  )) as Partial<ExtensionLocalState>;
  return {
    settings: normalizeSettings(stored.settings),
    recentRooms: Array.isArray(stored.recentRooms)
      ? stored.recentRooms.map(normalizeRecentRoom)
      : [],
    watchProgress:
      typeof stored.watchProgress === "object" && stored.watchProgress !== null
        ? (stored.watchProgress as Record<string, WatchProgressEntry>)
        : {},
  };
}

function normalizeSettings(settings: unknown): ExtensionSettings {
  if (typeof settings !== "object" || settings === null) {
    return DEFAULT_SETTINGS;
  }

  const candidate = settings as Partial<ExtensionSettings>;
  const displayName =
    typeof candidate.displayName === "string"
      ? candidate.displayName.trim()
      : "";

  return {
    backendHttpUrl:
      typeof candidate.backendHttpUrl === "string" &&
      candidate.backendHttpUrl.trim().length > 0
        ? candidate.backendHttpUrl
        : DEFAULT_SETTINGS.backendHttpUrl,
    backendWsUrl:
      typeof candidate.backendWsUrl === "string" &&
      candidate.backendWsUrl.trim().length > 0
        ? normalizeBackendWsUrl(candidate.backendWsUrl)
        : DEFAULT_SETTINGS.backendWsUrl,
    themeMode:
      candidate.themeMode === "light" ||
      candidate.themeMode === "dark" ||
      candidate.themeMode === "system"
        ? candidate.themeMode
        : DEFAULT_SETTINGS.themeMode,
    displayName:
      displayName.length > 0
        ? displayName.slice(0, 40)
        : DEFAULT_SETTINGS.displayName,
  };
}

function normalizeRecentRoom(room: unknown): RecentRoomEntry {
  const candidate =
    typeof room === "object" && room !== null
      ? (room as Partial<RecentRoomEntry>)
      : {};

  return {
    roomId:
      typeof candidate.roomId === "string" ? candidate.roomId : "unknown-room",
    shareUrl: typeof candidate.shareUrl === "string" ? candidate.shareUrl : "",
    episodeTitle:
      typeof candidate.episodeTitle === "string"
        ? candidate.episodeTitle
        : "Saved room",
    episodeUrl:
      typeof candidate.episodeUrl === "string" ? candidate.episodeUrl : "",
    updatedAt:
      typeof candidate.updatedAt === "number" ? candidate.updatedAt : 0,
    label:
      typeof candidate.label === "string" && candidate.label.trim().length > 0
        ? candidate.label.trim()
        : undefined,
  };
}

export async function getSettings(): Promise<ExtensionSettings> {
  const state = await getState();
  return state.settings;
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  await browser.storage.local.set({ settings: normalizeSettings(settings) });
}

export async function resetSettings(): Promise<void> {
  await browser.storage.local.set({ settings: DEFAULT_SETTINGS });
}

export async function listRecentRooms(): Promise<RecentRoomEntry[]> {
  const state = await getState();
  return state.recentRooms
    .slice()
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function upsertRecentRoom(entry: RecentRoomEntry): Promise<void> {
  const rooms = await listRecentRooms();
  const nextRooms = [
    normalizeRecentRoom(entry),
    ...rooms.filter((room) => room.roomId !== entry.roomId),
  ].slice(0, MAX_RECENT_ROOMS);
  await browser.storage.local.set({ recentRooms: nextRooms });
}

export async function renameRecentRoom(
  roomId: string,
  label: string,
): Promise<void> {
  const rooms = await listRecentRooms();
  const trimmedLabel = label.trim();
  const nextRooms = rooms.map((room) =>
    room.roomId === roomId
      ? {
          ...room,
          label: trimmedLabel.length > 0 ? trimmedLabel : undefined,
          updatedAt: Date.now(),
        }
      : room,
  );
  await browser.storage.local.set({ recentRooms: nextRooms });
}

export async function deleteRecentRoom(roomId: string): Promise<void> {
  const rooms = await listRecentRooms();
  await browser.storage.local.set({
    recentRooms: rooms.filter((room) => room.roomId !== roomId),
  });
}

export async function listWatchProgress(): Promise<WatchProgressEntry[]> {
  const state = await getState();
  return Object.values(state.watchProgress)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_WATCHED_ITEMS);
}

export async function getWatchProgressForEpisode(
  episodeUrl: string | undefined,
): Promise<WatchProgressEntry | undefined> {
  if (!episodeUrl) {
    return undefined;
  }

  const state = await getState();
  return state.watchProgress[episodeUrl];
}

export async function upsertWatchProgress(
  playback: PlaybackSnapshot,
): Promise<void> {
  const state = await getState();
  const nextWatchProgress = {
    ...state.watchProgress,
    [playback.episodeUrl]: toWatchProgressEntry(playback),
  };

  const trimmedEntries = Object.values(nextWatchProgress)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_WATCHED_ITEMS);

  const trimmedRecord = Object.fromEntries(
    trimmedEntries.map((entry) => [entry.episodeUrl, entry]),
  );

  await browser.storage.local.set({ watchProgress: trimmedRecord });
}

export async function clearLocalProgress(): Promise<void> {
  await browser.storage.local.set({ recentRooms: [], watchProgress: {} });
}
