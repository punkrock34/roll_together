import type { Browser } from "wxt/browser";

import type { RoomConnectionStatus } from "../../core/messages";
import type {
  ParticipantPresence,
  PlaybackSnapshot,
} from "../../core/protocol";

export interface TabSession {
  tabId: number;
  ports: Map<number, Browser.runtime.Port>;
  activeFrameId?: number;
  tabUrl?: string;
  tabTitle?: string;
  localPlayback?: PlaybackSnapshot;
  roomPlayback?: PlaybackSnapshot;
  roomIdFromUrl?: string | null;
  roomId?: string;
  sessionId?: string;
  hostSessionId?: string;
  pendingHostTakeoverPlayback?: PlaybackSnapshot;
  participantCount: number;
  participants: ParticipantPresence[];
  connectionState: RoomConnectionStatus;
  lastError?: string;
  socket?: WebSocket;
  pingInterval?: ReturnType<typeof setInterval>;
  reconnectTimeout?: ReturnType<typeof setTimeout>;
  cleanupTimeout?: ReturnType<typeof setTimeout>;
  autoJoinSuppressedRoomId?: string;
  lastOutboundPlayback?: PlaybackSnapshot;
  lastOutboundAt?: number;
  lastWatchProgressAt?: number;
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
