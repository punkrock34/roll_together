import type {
  EpisodeInfo,
  ParticipantPresence,
  PlaybackSnapshot,
  RoomStateSnapshot,
} from "./protocol";
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
  | "play"
  | "pause"
  | "seeked"
  | "discontinuity"
  | "heartbeat"
  | "remote-apply";

export interface PlayerRuntimeState {
  paused: boolean;
  currentTime: number;
  duration: number | null;
  playbackRate: number;
  readyState: number;
  seeking: boolean;
  ended: boolean;
  episodeId: string;
  updatedAt: number;
}

export interface ContentSnapshotMessage {
  type: "content:snapshot";
  tabUrl: string;
  episode: EpisodeInfo;
  playback: PlaybackSnapshot;
  playerState?: PlayerRuntimeState;
  roomIdFromUrl?: string | null;
  reason: ContentSnapshotReason;
}

export interface ContentCommandResultMessage {
  type: "content:command-result";
  commandId: string;
  revision: number;
  status: "applied" | "failed" | "timed_out";
  message?: string;
  snapshot?: PlaybackSnapshot;
}

export interface ContentPlayerStateMessage {
  type: "content:player-state";
  commandId: string;
  revision: number;
  roomId: string;
  playerState?: PlayerRuntimeState;
  playback?: PlaybackSnapshot;
  error?: string;
}

export type ContentOutboundMessage =
  | ContentSnapshotMessage
  | ContentCommandResultMessage
  | ContentPlayerStateMessage;

export interface ApplyRemotePlaybackMessage {
  type: "background:apply-state-snapshot";
  commandId: string;
  roomId: string;
  revision: number;
  state: RoomStateSnapshot;
  playback: PlaybackSnapshot;
  driftThresholdSeconds?: number;
}

export interface QueryPlayerStateMessage {
  type: "background:query-player-state";
  commandId: string;
  roomId: string;
  revision: number;
}

export type BackgroundOutboundMessage =
  | ApplyRemotePlaybackMessage
  | QueryPlayerStateMessage;

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

export interface PopupTransferHostMessage {
  type: "popup:transfer-host";
  tabId: number;
  targetSessionId: string;
}

export type PopupRequestMessage =
  | PopupGetStateMessage
  | PopupCreateRoomMessage
  | PopupDisconnectRoomMessage
  | PopupTransferHostMessage;

export interface PopupStateResponse {
  activeTabId?: number;
  activeTabUrl?: string;
  supported: boolean;
  providerReady: boolean;
  connectionState: RoomConnectionStatus;
  roomId?: string;
  shareUrl?: string;
  participantCount: number;
  participants: ParticipantPresence[];
  episodeTitle?: string;
  backendHttpUrl: string;
  backendWsUrl: string;
  displayName: string;
  recentRooms: RecentRoomEntry[];
  watchProgress?: WatchProgressEntry;
  lastError?: string;
  sessionId?: string;
  roomRevision?: number;
  episodeMismatch?: boolean;
  episodeMismatchMessage?: string;
  isHost: boolean;
  themeMode: ThemeMode;
}
