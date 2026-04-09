import type { Browser } from "wxt/browser";
import type { Socket } from "socket.io-client";

import type { RoomConnectionStatus } from "../../core/messages";
import type {
  ParticipantPresence,
  PlaybackSnapshot,
  RoomControlMode,
  RoomStateSnapshot,
} from "../../core/protocol";

export interface TabSession {
  tabId: number;
  ports: Map<number, Browser.runtime.Port>;
  activeFrameId?: number;
  tabUrl?: string;
  tabTitle?: string;
  localPlayback?: PlaybackSnapshot;
  roomPlayback?: PlaybackSnapshot;
  roomState?: RoomStateSnapshot;
  roomRevision?: number;
  navigationRevision?: number;
  hostSessionId?: string;
  controlMode?: RoomControlMode;
  canControlPlayback: boolean;
  canNavigateEpisodes: boolean;
  canTransferHost: boolean;
  latestAppliedRevision?: number;
  latestDeliveredCommandId?: string;
  latestCommandStatus?: "delivered" | "applied" | "failed" | "timed_out";
  latestCommandMessage?: string;
  roomIdFromUrl?: string | null;
  roomId?: string;
  sessionId?: string;
  episodeMismatch?: {
    localEpisodeId?: string;
    roomEpisodeId: string;
  };
  participantCount: number;
  participants: ParticipantPresence[];
  connectionState: RoomConnectionStatus;
  lastError?: string;
  socket?: Socket;
  pingInterval?: ReturnType<typeof setInterval>;
  reconnectTimeout?: ReturnType<typeof setTimeout>;
  cleanupTimeout?: ReturnType<typeof setTimeout>;
  autoJoinSuppressedRoomId?: string;
  lastWatchProgressAt?: number;
  lastStateRequestAt?: number;
  lastSameRevisionReapplyAt?: number;
  verificationTransaction?: {
    commandId: string;
    roomId: string;
    revision: number;
    targetPlayback: PlaybackSnapshot;
    targetState: "playing" | "paused";
    requiresSeek: boolean;
    deadlineAt: number;
    playBaselineAt?: number;
    playBaselineTime?: number;
    pollInterval?: ReturnType<typeof setInterval>;
  };
  watchdogInterval?: ReturnType<typeof setInterval>;
  watchdogPending?: {
    commandId: string;
    roomId: string;
    revision: number;
    issuedAt: number;
  };
  pendingRemoteNavigation?: {
    navigationRevision: number;
    episodeId: string;
    targetUrl: string;
    initiatedBySessionId: string;
    issuedAt: number;
  };
  reconnectAttempt: number;
}

export function getOrCreateSession(
  sessions: Map<number, TabSession>,
  tabId: number,
): TabSession {
  const existing = sessions.get(tabId);
  if (existing) {
    return existing;
  }

  const created: TabSession = {
    tabId,
    ports: new Map<number, Browser.runtime.Port>(),
    participantCount: 1,
    participants: [],
    connectionState: "ready",
    canControlPlayback: false,
    canNavigateEpisodes: false,
    canTransferHost: false,
    reconnectAttempt: 0,
  };
  sessions.set(tabId, created);
  return created;
}

export function getActivePort(
  session: TabSession,
): Browser.runtime.Port | undefined {
  if (session.activeFrameId !== undefined) {
    return session.ports.get(session.activeFrameId);
  }

  return session.ports.values().next().value;
}
