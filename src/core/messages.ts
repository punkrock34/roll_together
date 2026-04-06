import type { EpisodeInfo, PlaybackSnapshot } from "./protocol";
import type { RecentRoomEntry, ThemeMode, WatchProgressEntry } from "./storage";

export const CONTENT_PORT_NAME = "roll-together-content";
export const POPUP_PORT_NAME = "roll-together-popup";
export const POPUP_STATE_PORT_NAME = "roll-together-popup-state";

export type RoomConnectionStatus =
  | "unsupported"
  | "ready"
  | "connecting"
  | "switching"
  | "connected"
  | "error";

export type ContentSnapshotReason =
  | "initial"
  | "interaction"
  | "heartbeat"
  | "navigation";

export interface ContentSnapshotMessage {
  type: "content:snapshot";
  tabUrl: string;
  episode: EpisodeInfo;
  playback: PlaybackSnapshot;
  roomIdFromUrl?: string | null;
  reason: ContentSnapshotReason;
}

export type ContentOutboundMessage = ContentSnapshotMessage;

export interface ApplyRemotePlaybackMessage {
  type: "background:apply-remote";
  roomId: string;
  participantCount: number;
  hostSessionId: string;
  playback: PlaybackSnapshot;
}

export type BackgroundOutboundMessage = ApplyRemotePlaybackMessage;

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
  backendHttpUrl: string;
  backendWsUrl: string;
  recentRooms: RecentRoomEntry[];
  watchProgress?: WatchProgressEntry;
  lastError?: string;
  hostSessionId?: string;
  sessionId?: string;
  isHost: boolean;
  themeMode: ThemeMode;
}
