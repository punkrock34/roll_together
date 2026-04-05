import type { PlaybackSnapshot } from "./protocol";
import type { RecentRoomEntry, WatchProgressEntry } from "./storage";
import type { EpisodeInfo } from "./protocol";

export const CONTENT_PORT_NAME = "roll-together-content";
export const POPUP_PORT_NAME = "roll-together-popup";

export type RoomConnectionStatus =
  | "unsupported"
  | "ready"
  | "connecting"
  | "connected"
  | "error";

export interface ContentSnapshotMessage {
  type: "content:snapshot";
  tabUrl: string;
  episode: EpisodeInfo;
  playback: PlaybackSnapshot;
  roomIdFromUrl?: string | null;
}

export type ContentOutboundMessage = ContentSnapshotMessage;

export interface ApplyRemotePlaybackMessage {
  type: "background:apply-remote";
  roomId: string;
  participantCount: number;
  playback: PlaybackSnapshot;
}

export interface RoomStateMessage {
  type: "background:room-state";
  connectionState: RoomConnectionStatus;
  roomId?: string;
  participantCount: number;
  lastError?: string;
}

export type BackgroundOutboundMessage =
  | ApplyRemotePlaybackMessage
  | RoomStateMessage;

export interface PopupGetStateMessage {
  type: "popup:get-active-tab-state";
}

export interface PopupCreateRoomMessage {
  type: "popup:create-room";
  tabId: number;
}

export interface PopupDisconnectRoomMessage {
  type: "popup:disconnect-room";
  tabId: number;
}

export type PopupRequestMessage =
  | PopupGetStateMessage
  | PopupCreateRoomMessage
  | PopupDisconnectRoomMessage;

export interface PopupStateResponse {
  activeTabId?: number;
  activeTabUrl?: string;
  supported: boolean;
  providerReady: boolean;
  connectionState: RoomConnectionStatus;
  roomId?: string;
  shareUrl?: string;
  participantCount: number;
  episodeTitle?: string;
  backendWsUrl: string;
  recentRooms: RecentRoomEntry[];
  watchProgress?: WatchProgressEntry;
  lastError?: string;
}
