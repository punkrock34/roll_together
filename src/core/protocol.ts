export const PROTOCOL_VERSION = 4;
export const ROOM_QUERY_PARAM = "rollTogetherRoom";

export type ProviderName = "crunchyroll";
export type PlaybackState = "playing" | "paused";
export type ClientEventName =
  | "join_room"
  | "leave_room"
  | "play"
  | "pause"
  | "seek"
  | "request_state"
  | "heartbeat";
export type ServerEventName =
  | "room_joined"
  | "state_snapshot"
  | "presence_update"
  | "command_error"
  | "heartbeat_ack";
export type CommandErrorCode =
  | "invalid_message"
  | "invalid_payload"
  | "unknown_room"
  | "not_joined"
  | "episode_mismatch";

export interface EpisodeInfo {
  provider: ProviderName;
  episodeId: string;
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

export interface RoomStateSnapshot {
  roomId: string;
  revision: number;
  updatedAt: number;
  playback: PlaybackSnapshot;
  participants: ParticipantPresence[];
  participantCount: number;
}

export interface JoinRoomPayload {
  version: number;
  roomId?: string;
  sessionId?: string;
  displayName?: string;
  playback: PlaybackSnapshot;
}

export interface LeaveRoomPayload {
  version: number;
}

export interface PlaybackCommandPayload {
  version: number;
  playback: PlaybackSnapshot;
}

export interface RequestStatePayload {
  version: number;
}

export interface HeartbeatPayload {
  version: number;
  sentAt: number;
}

export interface RoomJoinedPayload {
  version: number;
  roomId: string;
  sessionId: string;
  state: RoomStateSnapshot;
}

export interface StateSnapshotPayload {
  version: number;
  state: RoomStateSnapshot;
}

export interface PresenceUpdatePayload {
  version: number;
  roomId: string;
  participantCount: number;
  participants: ParticipantPresence[];
  revision: number;
  updatedAt: number;
}

export interface CommandErrorPayload {
  version: number;
  code: CommandErrorCode;
  message: string;
}

export interface HeartbeatAckPayload {
  version: number;
  sentAt: number;
  receivedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isString(value: unknown) {
  return typeof value === "string";
}

function isNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isCurrentProtocolVersion(value: unknown) {
  return value === PROTOCOL_VERSION;
}

function isPlaybackState(value: unknown): value is PlaybackState {
  return value === "playing" || value === "paused";
}

function isParticipantPresence(value: unknown): value is ParticipantPresence {
  return (
    isRecord(value) &&
    isNonEmptyString(value.sessionId) &&
    (value.displayName === undefined || isString(value.displayName)) &&
    typeof value.isHost === "boolean" &&
    isFiniteNumber(value.joinedAt) &&
    isFiniteNumber(value.lastSeenAt) &&
    typeof value.connected === "boolean"
  );
}

export function isPlaybackSnapshot(value: unknown): value is PlaybackSnapshot {
  if (!isRecord(value)) {
    return false;
  }

  const currentTime = value.currentTime;
  const duration = value.duration;
  const playbackRate = value.playbackRate;

  return (
    value.provider === "crunchyroll" &&
    isNonEmptyString(value.episodeId) &&
    isString(value.episodeUrl) &&
    isString(value.episodeTitle) &&
    isPlaybackState(value.state) &&
    isFiniteNumber(currentTime) &&
    currentTime >= 0 &&
    (duration === null || (isFiniteNumber(duration) && duration >= 0)) &&
    isFiniteNumber(playbackRate) &&
    playbackRate > 0 &&
    isFiniteNumber(value.updatedAt)
  );
}

export function isRoomStateSnapshot(
  value: unknown,
): value is RoomStateSnapshot {
  if (!isRecord(value)) {
    return false;
  }

  const revision = value.revision;
  return (
    isNonEmptyString(value.roomId) &&
    isFiniteNumber(revision) &&
    revision >= 0 &&
    isFiniteNumber(value.updatedAt) &&
    isPlaybackSnapshot(value.playback) &&
    Array.isArray(value.participants) &&
    value.participants.every((participant) =>
      isParticipantPresence(participant),
    ) &&
    isFiniteNumber(value.participantCount)
  );
}

export function parseRoomJoinedPayload(
  value: unknown,
): RoomJoinedPayload | null {
  if (
    !isRecord(value) ||
    !isCurrentProtocolVersion(value.version) ||
    !isNonEmptyString(value.roomId) ||
    !isNonEmptyString(value.sessionId) ||
    !isRoomStateSnapshot(value.state)
  ) {
    return null;
  }
  return value as unknown as RoomJoinedPayload;
}

export function parseStateSnapshotPayload(
  value: unknown,
): StateSnapshotPayload | null {
  if (
    !isRecord(value) ||
    !isCurrentProtocolVersion(value.version) ||
    !isRoomStateSnapshot(value.state)
  ) {
    return null;
  }
  return value as unknown as StateSnapshotPayload;
}

export function parsePresenceUpdatePayload(
  value: unknown,
): PresenceUpdatePayload | null {
  if (
    !isRecord(value) ||
    !isCurrentProtocolVersion(value.version) ||
    !isNonEmptyString(value.roomId) ||
    !Array.isArray(value.participants) ||
    !value.participants.every((participant) =>
      isParticipantPresence(participant),
    ) ||
    !isFiniteNumber(value.participantCount) ||
    !isFiniteNumber(value.revision) ||
    !isFiniteNumber(value.updatedAt)
  ) {
    return null;
  }
  return value as unknown as PresenceUpdatePayload;
}

export function parseCommandErrorPayload(
  value: unknown,
): CommandErrorPayload | null {
  if (
    !isRecord(value) ||
    !isCurrentProtocolVersion(value.version) ||
    !isString(value.code) ||
    !isString(value.message)
  ) {
    return null;
  }

  const knownCode = [
    "invalid_message",
    "invalid_payload",
    "unknown_room",
    "not_joined",
    "episode_mismatch",
  ] satisfies CommandErrorCode[];

  if (!knownCode.includes(value.code as CommandErrorCode)) {
    return null;
  }

  return value as unknown as CommandErrorPayload;
}

export function parseHeartbeatAckPayload(
  value: unknown,
): HeartbeatAckPayload | null {
  if (
    !isRecord(value) ||
    !isCurrentProtocolVersion(value.version) ||
    !isFiniteNumber(value.sentAt) ||
    !isFiniteNumber(value.receivedAt)
  ) {
    return null;
  }
  return value as unknown as HeartbeatAckPayload;
}
