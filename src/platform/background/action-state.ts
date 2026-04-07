import { browser } from "wxt/browser";

import { runActionUpdate } from "./runtime-errors";
import type { TabSession } from "./session-state";

const DEFAULT_ACTION_TITLE = "Roll Together";

export function updateActionState(session: TabSession) {
  runActionUpdate(
    browser.action.setTitle({
      tabId: session.tabId,
      title: getActionTitle(session),
    }),
  );

  const badgeText = getActionBadgeText(session);
  runActionUpdate(
    browser.action.setBadgeText({
      tabId: session.tabId,
      text: badgeText,
    }),
  );

  if (!badgeText) {
    return;
  }

  runActionUpdate(
    browser.action.setBadgeBackgroundColor({
      tabId: session.tabId,
      color: getActionBadgeColor(session),
    }),
  );
}

export function clearActionState(tabId: number) {
  runActionUpdate(
    browser.action.setTitle({
      tabId,
      title: DEFAULT_ACTION_TITLE,
    }),
  );
  runActionUpdate(
    browser.action.setBadgeText({
      tabId,
      text: "",
    }),
  );
}

function getActionBadgeText(session: TabSession): string {
  if (session.connectionState === "connected") {
    return session.participantCount > 9
      ? "9+"
      : `${Math.max(session.participantCount, 1)}`;
  }

  if (
    session.connectionState === "connecting" ||
    session.connectionState === "switching"
  ) {
    return "...";
  }

  if (session.connectionState === "error") {
    return "!";
  }

  if (session.localPlayback) {
    return "ON";
  }

  return "";
}

function getActionBadgeColor(session: TabSession): string {
  if (session.connectionState === "connected") {
    return "#f97316";
  }

  if (
    session.connectionState === "connecting" ||
    session.connectionState === "switching"
  ) {
    return "#f59e0b";
  }

  if (session.connectionState === "error") {
    return "#ef4444";
  }

  return "#22c55e";
}

function getActionTitle(session: TabSession): string {
  if (session.connectionState === "connected" && session.roomId) {
    const role =
      session.sessionId && session.hostSessionId === session.sessionId
        ? "host"
        : "viewer";
    return `Roll Together: ${role} in ${session.roomId.slice(0, 8)} with ${session.participantCount} viewer${session.participantCount === 1 ? "" : "s"}`;
  }

  if (session.connectionState === "switching") {
    return "Roll Together: Switching episode";
  }

  if (session.connectionState === "connecting") {
    return "Roll Together: Connecting to room";
  }

  if (session.connectionState === "error") {
    return `Roll Together: ${session.lastError ?? "Connection issue"}`;
  }

  if (session.localPlayback?.episodeTitle) {
    return `Roll Together: Player detected for ${session.localPlayback.episodeTitle}`;
  }

  return DEFAULT_ACTION_TITLE;
}
