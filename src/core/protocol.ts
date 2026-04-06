export const PROTOCOL_VERSION = 2;
export const ROOM_QUERY_PARAM = "rollTogetherRoom";

export type ProviderName = "crunchyroll";
export type PlaybackState = "playing" | "paused";
export type RoomMutationErrorCode = "unknown_room" | "not_joined" | "not_host";

export interface EpisodeInfo {
  provider: ProviderName;
  episodeUrl: string;
  episodeTitle: string;
}

export interface PlaybackSnapshot extends EpisodeInfo {
  state: PlaybackState;
  currentTime: number;
  duration: number | null;
  playbackRate: number;
  updatedAt: number;
}

export interface ParticipantPresence {
  sessionId: string;
  displayName?: string;
  isHost: boolean;
  joinedAt: number;
  lastSeenAt: number;
  connected: boolean;
}

export interface JoinMessage {
  type: "join";
  version: number;
  roomId?: string;
  sessionId?: string;
  displayName?: string;
  playback: PlaybackSnapshot;
}

export interface SyncMessage {
  type: "sync";
  version: number;
  playback: PlaybackSnapshot;
}

export interface NavigateMessage {
  type: "navigate";
  version: number;
  playback: PlaybackSnapshot;
}

export interface LeaveMessage {
  type: "leave";
  version: number;
}

export interface PingMessage {
  type: "ping";
  version: number;
  sentAt: number;
}

export type ClientMessage =
  | JoinMessage
  | SyncMessage
  | NavigateMessage
  | LeaveMessage
  | PingMessage;

interface RoomSnapshotMessageBase {
  roomId: string;
  participantCount: number;
  participants: ParticipantPresence[];
  hostSessionId: string;
  playback: PlaybackSnapshot;
}

export interface JoinedMessage extends RoomSnapshotMessageBase {
  type: "joined";
  version: number;
  sessionId: string;
}

interface RoomBroadcastMessageBase extends RoomSnapshotMessageBase {
  version: number;
  participantId: string;
}

export interface SyncBroadcastMessage extends RoomBroadcastMessageBase {
  type: "sync";
}

export interface NavigateBroadcastMessage extends RoomBroadcastMessageBase {
  type: "navigate";
}

export interface PresenceMessage {
  type: "presence";
  version: number;
  roomId: string;
  participantCount: number;
  participants: ParticipantPresence[];
  hostSessionId: string;
}

export interface PongMessage {
  type: "pong";
  version: number;
  sentAt: number;
  receivedAt: number;
}

export interface ErrorMessage {
  type: "error";
  version: number;
  code: RoomMutationErrorCode | "invalid_message";
  message: string;
}

export type ServerMessage =
  | JoinedMessage
  | SyncBroadcastMessage
  | NavigateBroadcastMessage
  | PresenceMessage
  | PongMessage
  | ErrorMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPlaybackState(value: unknown): value is PlaybackState {
  return value === "playing" || value === "paused";
}

export function isPlaybackSnapshot(value: unknown): value is PlaybackSnapshot {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.provider === "crunchyroll" &&
    typeof value.episodeUrl === "string" &&
    typeof value.episodeTitle === "string" &&
    isPlaybackState(value.state) &&
    typeof value.currentTime === "number" &&
    (typeof value.duration === "number" || value.duration === null) &&
    typeof value.playbackRate === "number" &&
    typeof value.updatedAt === "number"
  );
}

export function parseServerMessage(raw: string): ServerMessage | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    return null;
  }

  switch (parsed.type) {
    case "joined":
      return isPlaybackSnapshot(parsed.playback) &&
        typeof parsed.roomId === "string" &&
        typeof parsed.sessionId === "string" &&
        typeof parsed.participantCount === "number" &&
        Array.isArray(parsed.participants) &&
        typeof parsed.hostSessionId === "string"
        ? (parsed as unknown as JoinedMessage)
        : null;
    case "sync":
      return isPlaybackSnapshot(parsed.playback) &&
        typeof parsed.roomId === "string" &&
        typeof parsed.participantId === "string" &&
        typeof parsed.participantCount === "number" &&
        Array.isArray(parsed.participants) &&
        typeof parsed.hostSessionId === "string"
        ? (parsed as unknown as SyncBroadcastMessage)
        : null;
    case "navigate":
      return isPlaybackSnapshot(parsed.playback) &&
        typeof parsed.roomId === "string" &&
        typeof parsed.participantId === "string" &&
        typeof parsed.participantCount === "number" &&
        Array.isArray(parsed.participants) &&
        typeof parsed.hostSessionId === "string"
        ? (parsed as unknown as NavigateBroadcastMessage)
        : null;
    case "presence":
      return typeof parsed.roomId === "string" &&
        typeof parsed.participantCount === "number" &&
        Array.isArray(parsed.participants) &&
        typeof parsed.hostSessionId === "string"
        ? (parsed as unknown as PresenceMessage)
        : null;
    case "pong":
      return typeof parsed.sentAt === "number" &&
        typeof parsed.receivedAt === "number"
        ? (parsed as unknown as PongMessage)
        : null;
    case "error":
      return typeof parsed.code === "string" &&
        typeof parsed.message === "string"
        ? (parsed as unknown as ErrorMessage)
        : null;
    default:
      return null;
  }
}
