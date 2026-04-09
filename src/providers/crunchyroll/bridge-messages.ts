import type {
  ApplyRemotePlaybackMessage,
  ContentCommandResultMessage,
  ContentPlayerStateMessage,
  ContentSnapshotReason,
  PlayerRuntimeState,
  QueryPlayerStateMessage,
} from "../../core/messages";
import type { PlaybackSnapshot } from "../../core/protocol";

export const CRUNCHYROLL_BRIDGE_NAMESPACE =
  "roll-together.crunchyroll.bridge.v1";
export const CRUNCHYROLL_BRIDGE_VERSION = 1;

export type BridgeContentToPageType =
  | "bridge:init"
  | "bridge:apply-remote"
  | "bridge:query-player-state"
  | "bridge:teardown";

export type BridgePageToContentType =
  | "bridge:ready"
  | "bridge:snapshot"
  | "bridge:player-state"
  | "bridge:command-result"
  | "bridge:error";

export type BridgeMessageType =
  | BridgeContentToPageType
  | BridgePageToContentType;

export interface BridgeEnvelope<TType extends BridgeMessageType, TPayload> {
  namespace: typeof CRUNCHYROLL_BRIDGE_NAMESPACE;
  version: typeof CRUNCHYROLL_BRIDGE_VERSION;
  bridgeId: string;
  type: TType;
  requestId?: string;
  payload: TPayload;
}

export interface BridgeInitPayload {
  tabUrl: string;
  title: string;
  issuedAt: number;
}

export interface BridgeApplyRemotePayload {
  message: ApplyRemotePlaybackMessage;
}

export interface BridgeQueryPlayerStatePayload {
  message: QueryPlayerStateMessage;
}

export interface BridgeTeardownPayload {
  reason: string;
}

export interface BridgeReadyPayload {
  tabUrl: string;
  issuedAt: number;
}

export interface BridgeSnapshotPayload {
  tabUrl: string;
  roomIdFromUrl?: string | null;
  reason: ContentSnapshotReason;
  playback: PlaybackSnapshot;
  playerState?: PlayerRuntimeState;
}

export interface BridgePlayerStatePayload {
  message: ContentPlayerStateMessage;
}

export interface BridgeCommandResultPayload {
  message: ContentCommandResultMessage;
}

export interface BridgeErrorPayload {
  code:
    | "bridge_uninitialized"
    | "player_unavailable"
    | "apply_failed"
    | "unknown";
  message: string;
}

export type BridgeContentToPageMessage =
  | BridgeEnvelope<"bridge:init", BridgeInitPayload>
  | BridgeEnvelope<"bridge:apply-remote", BridgeApplyRemotePayload>
  | BridgeEnvelope<"bridge:query-player-state", BridgeQueryPlayerStatePayload>
  | BridgeEnvelope<"bridge:teardown", BridgeTeardownPayload>;

export type BridgePageToContentMessage =
  | BridgeEnvelope<"bridge:ready", BridgeReadyPayload>
  | BridgeEnvelope<"bridge:snapshot", BridgeSnapshotPayload>
  | BridgeEnvelope<"bridge:player-state", BridgePlayerStatePayload>
  | BridgeEnvelope<"bridge:command-result", BridgeCommandResultPayload>
  | BridgeEnvelope<"bridge:error", BridgeErrorPayload>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isBridgeEnvelope(
  value: unknown,
): value is BridgeEnvelope<BridgeMessageType, unknown> {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.namespace === CRUNCHYROLL_BRIDGE_NAMESPACE &&
    value.version === CRUNCHYROLL_BRIDGE_VERSION &&
    typeof value.bridgeId === "string" &&
    value.bridgeId.length > 0 &&
    typeof value.type === "string" &&
    "payload" in value
  );
}

export function isBridgeMessageForId(
  value: unknown,
  bridgeId: string,
): value is BridgeEnvelope<BridgeMessageType, unknown> {
  return isBridgeEnvelope(value) && value.bridgeId === bridgeId;
}

export function createBridgeEnvelope<TType extends BridgeMessageType, TPayload>(
  bridgeId: string,
  type: TType,
  payload: TPayload,
  requestId?: string,
): BridgeEnvelope<TType, TPayload> {
  return {
    namespace: CRUNCHYROLL_BRIDGE_NAMESPACE,
    version: CRUNCHYROLL_BRIDGE_VERSION,
    bridgeId,
    type,
    requestId,
    payload,
  };
}

export function isPageToContentMessage(
  value: unknown,
  bridgeId: string,
): value is BridgePageToContentMessage {
  if (!isBridgeMessageForId(value, bridgeId)) {
    return false;
  }

  return (
    value.type === "bridge:ready" ||
    value.type === "bridge:snapshot" ||
    value.type === "bridge:player-state" ||
    value.type === "bridge:command-result" ||
    value.type === "bridge:error"
  );
}

export function isContentToPageMessage(
  value: unknown,
  bridgeId: string,
): value is BridgeContentToPageMessage {
  if (!isBridgeMessageForId(value, bridgeId)) {
    return false;
  }

  return (
    value.type === "bridge:init" ||
    value.type === "bridge:apply-remote" ||
    value.type === "bridge:query-player-state" ||
    value.type === "bridge:teardown"
  );
}
