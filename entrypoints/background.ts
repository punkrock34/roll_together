import { browser } from "wxt/browser";

import {
  CONTENT_PORT_NAME,
  POPUP_PORT_NAME,
  POPUP_STATE_PORT_NAME,
  type ApplyRemotePlaybackMessage,
  type ContentOutboundMessage,
  type PopupRequestMessage,
  type PopupStateResponse,
} from "../src/core/messages";
import { DEFAULT_SETTINGS, type ExtensionSettings } from "../src/core/storage";
import { resolveRoomIdForTabContext } from "../src/providers/crunchyroll/session";
import {
  clearActionState,
  updateActionState,
} from "../src/platform/background/action-state";
import { createContentMessageController } from "../src/platform/background/content-messages";
import { createPopupStateController } from "../src/platform/background/popup-state";
import { createRoomConnectionController } from "../src/platform/background/room-connection";
import { isIgnorablePortError } from "../src/platform/background/runtime-errors";
import {
  getActivePort,
  getOrCreateSession,
  type TabSession,
} from "../src/platform/background/session-state";

const NAVIGATION_CLEANUP_TIMEOUT_MS = 12_000;
const DISCONNECTED_CLEANUP_TIMEOUT_MS = 3_000;

export default defineBackground({
  type: "module",
  main() {
    const sessions = new Map<number, TabSession>();
    const popupStateController = createPopupStateController({ sessions });

    const postToContent = (
      session: TabSession,
      message: ApplyRemotePlaybackMessage,
    ) => {
      const port = getActivePort(session);
      if (!port) {
        return;
      }

      try {
        port.postMessage(message);
      } catch (error) {
        if (!isIgnorablePortError(error)) {
          console.error("Failed to post to content script", error);
        }
      }
    };

    const publishRoomState = (session: TabSession) => {
      updateActionState(session);
      popupStateController.queuePopupStatePublish();
    };

    const roomConnectionController = createRoomConnectionController({
      publishRoomState,
      queuePopupStatePublish: popupStateController.queuePopupStatePublish,
      postToContent,
    });
    const contentMessageController = createContentMessageController({
      connectSession: roomConnectionController.connectSession,
      sendRoomUpdate: roomConnectionController.sendRoomUpdate,
      postToContent,
      publishRoomState,
    });

    const handlePopupMessage = async (
      message: PopupRequestMessage,
    ): Promise<PopupStateResponse | undefined> => {
      switch (message.type) {
        case "popup:get-active-tab-state":
          return popupStateController.buildActivePopupState();
        case "popup:create-room": {
          const session = sessions.get(message.tabId);
          if (session?.localPlayback) {
            session.autoJoinSuppressedRoomId = undefined;
            await roomConnectionController.connectSession(
              session,
              session.roomId,
            );
          }
          return popupStateController.buildActivePopupState();
        }
        case "popup:disconnect-room": {
          const session = sessions.get(message.tabId);
          if (session) {
            session.autoJoinSuppressedRoomId =
              session.roomIdFromUrl ?? session.roomId;
            roomConnectionController.closeSocket(session, {
              clearRoom: true,
              clearIdentity: true,
              suppressReconnect: true,
              sendLeave: true,
            });
            session.connectionState = "ready";
            session.lastError = undefined;
            publishRoomState(session);
          }
          return popupStateController.buildActivePopupState();
        }
      }
    };

    const safeHandlePopupMessage = async (
      message: PopupRequestMessage,
    ): Promise<PopupStateResponse> => {
      try {
        const response = await handlePopupMessage(message);
        if (response) {
          return response;
        }
      } catch (error) {
        console.error("Failed to handle popup message", error);
      }

      return popupStateController.safeBuildActivePopupState();
    };

    browser.runtime.onInstalled.addListener(() => {
      void browser.storage.local.get("settings").then((stored) => {
        if (!stored.settings) {
          return browser.storage.local.set({ settings: DEFAULT_SETTINGS });
        }
        return undefined;
      });
    });

    browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") {
        return;
      }

      if (changes.settings) {
        const previousSettings = changes.settings.oldValue as
          | ExtensionSettings
          | undefined;
        const nextSettings = changes.settings.newValue as
          | ExtensionSettings
          | undefined;
        const backendChanged =
          previousSettings?.backendWsUrl !== nextSettings?.backendWsUrl ||
          previousSettings?.backendHttpUrl !== nextSettings?.backendHttpUrl;
        const displayNameChanged =
          previousSettings?.displayName !== nextSettings?.displayName;

        if (backendChanged || displayNameChanged) {
          for (const session of sessions.values()) {
            if (
              !session.roomId ||
              !session.localPlayback ||
              !getActivePort(session)
            ) {
              continue;
            }

            void roomConnectionController.connectSession(
              session,
              session.roomId,
            );
          }
        }
      }

      popupStateController.queuePopupStatePublish();
    });

    browser.runtime.onMessage.addListener((message: PopupRequestMessage) => {
      return safeHandlePopupMessage(message);
    });

    browser.runtime.onConnect.addListener((port) => {
      if (port.name === POPUP_STATE_PORT_NAME) {
        popupStateController.registerPopupStatePort(port);
        return;
      }

      if (port.name === POPUP_PORT_NAME) {
        port.onMessage.addListener((message: PopupRequestMessage) => {
          void safeHandlePopupMessage(message).then((response) => {
            try {
              port.postMessage(response);
            } catch (error) {
              if (!isIgnorablePortError(error)) {
                console.error("Failed to respond to popup port", error);
              }
            }
          });
        });
        return;
      }

      if (port.name !== CONTENT_PORT_NAME) {
        return;
      }

      const tabId = port.sender?.tab?.id;
      const frameId = port.sender?.frameId ?? 0;

      if (!tabId) {
        return;
      }

      const session = getOrCreateSession(sessions, tabId);
      session.ports.set(frameId, port);
      session.connectionState =
        session.roomId && session.connectionState !== "switching"
          ? "connected"
          : session.connectionState === "switching"
            ? "switching"
            : "ready";

      if (session.cleanupTimeout) {
        clearTimeout(session.cleanupTimeout);
        session.cleanupTimeout = undefined;
      }

      publishRoomState(session);

      port.onMessage.addListener((message: ContentOutboundMessage) => {
        void contentMessageController.handleContentSnapshot(
          session,
          message,
          port,
        );
      });

      port.onDisconnect.addListener(() => {
        session.ports.delete(frameId);
        if (session.activeFrameId === frameId) {
          session.activeFrameId = undefined;
        }

        if (session.ports.size > 0) {
          return;
        }

        session.cleanupTimeout = setTimeout(
          () => {
            if (session.ports.size > 0) {
              return;
            }

            roomConnectionController.closeSocket(session, {
              clearRoom: true,
              clearIdentity: false,
              suppressReconnect: true,
              sendLeave: true,
            });
            sessions.delete(tabId);
            clearActionState(tabId);
          },
          session.roomId
            ? NAVIGATION_CLEANUP_TIMEOUT_MS
            : DISCONNECTED_CLEANUP_TIMEOUT_MS,
        );
      });
    });

    browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      const session = sessions.get(tabId);
      if (!session) {
        return;
      }

      if (typeof changeInfo.url === "string") {
        session.tabUrl = changeInfo.url;
        session.roomIdFromUrl = resolveRoomIdForTabContext(
          changeInfo.url,
          session.roomIdFromUrl,
        );
        if (session.roomId) {
          session.connectionState = "switching";
          session.lastError = undefined;
          publishRoomState(session);
        }
      }

      if (typeof tab.title === "string" && tab.title.trim().length > 0) {
        session.tabTitle = tab.title;
      }

      popupStateController.queuePopupStatePublish();
    });

    browser.tabs.onActivated.addListener(() => {
      popupStateController.queuePopupStatePublish();
    });

    browser.tabs.onRemoved.addListener((tabId) => {
      const session = sessions.get(tabId);
      if (!session) {
        popupStateController.queuePopupStatePublish();
        return;
      }

      roomConnectionController.closeSocket(session, {
        clearRoom: true,
        clearIdentity: false,
        suppressReconnect: true,
        sendLeave: true,
      });
      sessions.delete(tabId);
      clearActionState(tabId);
      popupStateController.queuePopupStatePublish();
    });
  },
});
