import { browser, type Browser } from "wxt/browser";

import type { PopupStateResponse } from "../../core/messages";
import {
  getSettings,
  getWatchProgressForEpisode,
  listRecentRooms,
  type ExtensionSettings,
} from "../../core/storage";
import { buildRoomInviteUrl } from "../../core/url";
import { isCrunchyrollUrl } from "../../providers/crunchyroll/player";

import { isIgnorablePortError } from "./runtime-errors";
import type { TabSession } from "./session-state";

interface PopupStateControllerOptions {
  sessions: Map<number, TabSession>;
}

export function createPopupStateController({
  sessions,
}: PopupStateControllerOptions) {
  const popupStatePorts = new Set<Browser.runtime.Port>();
  let popupStatePublishScheduled = false;

  const postPopupState = (
    port: Browser.runtime.Port,
    response: PopupStateResponse,
  ) => {
    try {
      port.postMessage(response);
    } catch (error) {
      if (!isIgnorablePortError(error)) {
        console.error("Failed to post popup state", error);
      }
    }
  };

  const buildUnsupportedPopupState = (
    settings: ExtensionSettings,
    recentRooms: Awaited<ReturnType<typeof listRecentRooms>>,
    lastError?: string,
  ): PopupStateResponse => ({
    supported: false,
    providerReady: false,
    connectionState: "unsupported",
    participantCount: 0,
    participants: [],
    backendHttpUrl: settings.backendHttpUrl,
    backendWsUrl: settings.backendWsUrl,
    displayName: settings.displayName,
    recentRooms,
    themeMode: settings.themeMode,
    lastError,
    isHost: false,
    controlMode: "shared_playback",
    canControlPlayback: false,
    canNavigateEpisodes: false,
    canTransferHost: false,
  });

  const buildActivePopupState = async (): Promise<PopupStateResponse> => {
    const activeTab = (
      await browser.tabs.query({
        active: true,
        currentWindow: true,
      })
    )[0];
    const settings = await getSettings();
    const recentRooms = await listRecentRooms();

    if (!activeTab?.id) {
      return buildUnsupportedPopupState(settings, recentRooms);
    }

    const session = sessions.get(activeTab.id);
    const supported =
      typeof activeTab.url === "string" && isCrunchyrollUrl(activeTab.url);
    const shareUrl =
      activeTab.url && session?.roomId
        ? buildRoomInviteUrl(activeTab.url, session.roomId)
        : undefined;
    const currentPlayback = session?.roomPlayback ?? session?.localPlayback;
    const isHost = Boolean(
      session?.sessionId &&
      session?.hostSessionId &&
      session.sessionId === session.hostSessionId,
    );

    return {
      activeTabId: activeTab.id,
      activeTabUrl: activeTab.url,
      supported,
      providerReady: Boolean(session?.localPlayback),
      connectionState: supported
        ? (session?.connectionState ?? "ready")
        : "unsupported",
      roomId: session?.roomId,
      shareUrl,
      participantCount: session?.participantCount ?? 0,
      participants: session?.participants ?? [],
      episodeTitle: currentPlayback?.episodeTitle,
      backendHttpUrl: settings.backendHttpUrl,
      backendWsUrl: settings.backendWsUrl,
      displayName: settings.displayName,
      recentRooms,
      watchProgress: await getWatchProgressForEpisode(
        currentPlayback?.episodeUrl,
      ),
      lastError: session?.lastError,
      sessionId: session?.sessionId,
      roomRevision: session?.roomRevision,
      episodeMismatch: Boolean(session?.episodeMismatch),
      episodeMismatchMessage: session?.episodeMismatch
        ? "Room episode does not match local episode."
        : undefined,
      isHost,
      hostSessionId: session?.hostSessionId,
      controlMode: session?.controlMode ?? "shared_playback",
      canControlPlayback: session?.canControlPlayback ?? false,
      canNavigateEpisodes: session?.canNavigateEpisodes ?? false,
      canTransferHost: session?.canTransferHost ?? false,
      themeMode: settings.themeMode,
    };
  };

  const safeBuildActivePopupState = async (): Promise<PopupStateResponse> => {
    try {
      return await buildActivePopupState();
    } catch (error) {
      console.error("Failed to build popup state", error);
    }

    const settings = await getSettings();
    const recentRooms = await listRecentRooms();
    return buildUnsupportedPopupState(
      settings,
      recentRooms,
      "Unable to read extension state.",
    );
  };

  const publishPopupStates = async () => {
    popupStatePublishScheduled = false;

    if (popupStatePorts.size === 0) {
      return;
    }

    const response = await safeBuildActivePopupState();
    for (const port of popupStatePorts) {
      postPopupState(port, response);
    }
  };

  const queuePopupStatePublish = () => {
    if (popupStatePorts.size === 0 || popupStatePublishScheduled) {
      return;
    }

    popupStatePublishScheduled = true;
    queueMicrotask(() => {
      void publishPopupStates();
    });
  };

  const registerPopupStatePort = (port: Browser.runtime.Port) => {
    popupStatePorts.add(port);
    void safeBuildActivePopupState().then((response) => {
      postPopupState(port, response);
    });
    port.onDisconnect.addListener(() => {
      popupStatePorts.delete(port);
    });
  };

  return {
    buildActivePopupState,
    safeBuildActivePopupState,
    queuePopupStatePublish,
    registerPopupStatePort,
  };
}
