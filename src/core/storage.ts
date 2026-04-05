import { browser } from "wxt/browser";

import type { ProviderName } from "./protocol";
import { toWatchProgressEntry } from "./watch-progress";
import type { PlaybackSnapshot } from "./protocol";

export interface ExtensionSettings {
  backendHttpUrl: string;
  backendWsUrl: string;
}

export interface RecentRoomEntry {
  roomId: string;
  shareUrl: string;
  episodeTitle: string;
  episodeUrl: string;
  updatedAt: number;
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
  backendWsUrl:
    import.meta.env.WXT_PUBLIC_BACKEND_WS_URL ?? "ws://localhost:3000/ws",
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
    settings:
      (stored.settings as ExtensionSettings | undefined) ?? DEFAULT_SETTINGS,
    recentRooms: Array.isArray(stored.recentRooms) ? stored.recentRooms : [],
    watchProgress:
      typeof stored.watchProgress === "object" && stored.watchProgress !== null
        ? (stored.watchProgress as Record<string, WatchProgressEntry>)
        : {},
  };
}

export async function getSettings(): Promise<ExtensionSettings> {
  const state = await getState();
  return state.settings;
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  await browser.storage.local.set({ settings });
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
    entry,
    ...rooms.filter((room) => room.roomId !== entry.roomId),
  ].slice(0, MAX_RECENT_ROOMS);
  await browser.storage.local.set({ recentRooms: nextRooms });
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
