import { browser } from "wxt/browser";

import {
  CONTENT_PORT_NAME,
  type ApplyRemotePlaybackMessage,
  type ContentOutboundMessage,
  type QueryPlayerStateMessage,
} from "../src/core/messages";
import { getRoomIdFromUrl } from "../src/core/url";
import {
  createBridgeEnvelope,
  isPageToContentMessage,
  type BridgeContentToPageMessage,
} from "../src/providers/crunchyroll/bridge-messages";

const MAX_QUEUED_PAGE_MESSAGES = 25;

export default defineContentScript({
  matches: ["*://crunchyroll.com/*", "*://*.crunchyroll.com/*"],
  allFrames: false,
  runAt: "document_start",
  main(ctx) {
    const bridgeId = `rt-bridge-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const port = browser.runtime.connect({ name: CONTENT_PORT_NAME });

    let pageReady = false;
    let portDisconnected = false;
    let handshakeIntervalId: number | undefined;
    const queuedPageMessages: BridgeContentToPageMessage[] = [];

    const safePostToBackground = (message: ContentOutboundMessage) => {
      if (portDisconnected) {
        return;
      }

      try {
        port.postMessage(message);
      } catch (error) {
        const errorMessage =
          error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : "";
        if (!errorMessage.includes("message channel is closed")) {
          console.error("Failed to post message to background", error);
        }
        portDisconnected = true;
      }
    };

    const sendToPage = (message: BridgeContentToPageMessage) => {
      if (!pageReady && message.type !== "bridge:init") {
        if (queuedPageMessages.length >= MAX_QUEUED_PAGE_MESSAGES) {
          queuedPageMessages.shift();
        }
        queuedPageMessages.push(message);
        return;
      }

      window.postMessage(message, "*");
    };

    const flushQueuedMessages = () => {
      while (queuedPageMessages.length > 0) {
        const nextMessage = queuedPageMessages.shift();
        if (!nextMessage) {
          break;
        }

        window.postMessage(nextMessage, "*");
      }
    };

    const sendInit = () => {
      sendToPage(
        createBridgeEnvelope(bridgeId, "bridge:init", {
          tabUrl: window.location.href,
          title: document.title,
          issuedAt: Date.now(),
        }),
      );
    };

    const sendTeardown = () => {
      window.postMessage(
        createBridgeEnvelope(bridgeId, "bridge:teardown", {
          reason: "content_port_disconnected",
        }),
        "*",
      );
    };

    const handleWindowMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== window) {
        return;
      }

      if (!isPageToContentMessage(event.data, bridgeId)) {
        return;
      }

      if (event.data.type === "bridge:ready") {
        pageReady = true;
        flushQueuedMessages();

        if (handshakeIntervalId !== undefined) {
          window.clearInterval(handshakeIntervalId);
          handshakeIntervalId = undefined;
        }

        return;
      }

      if (event.data.type === "bridge:snapshot") {
        const { playback } = event.data.payload;
        safePostToBackground({
          type: "content:snapshot",
          tabUrl: event.data.payload.tabUrl,
          episode: {
            provider: playback.provider,
            episodeId: playback.episodeId,
            episodeUrl: playback.episodeUrl,
            episodeTitle: playback.episodeTitle,
          },
          playback,
          playerState: event.data.payload.playerState,
          roomIdFromUrl:
            event.data.payload.roomIdFromUrl ??
            getRoomIdFromUrl(event.data.payload.tabUrl),
          reason: event.data.payload.reason,
        });
        return;
      }

      if (event.data.type === "bridge:player-state") {
        safePostToBackground(event.data.payload.message);
        return;
      }

      if (event.data.type === "bridge:command-result") {
        safePostToBackground(event.data.payload.message);
        return;
      }

      if (event.data.type === "bridge:error") {
        console.warn("Page bridge reported an error", {
          bridgeId,
          code: event.data.payload.code,
          message: event.data.payload.message,
        });
      }
    };

    const cleanup = () => {
      window.removeEventListener("message", handleWindowMessage);

      if (handshakeIntervalId !== undefined) {
        window.clearInterval(handshakeIntervalId);
        handshakeIntervalId = undefined;
      }

      sendTeardown();
    };

    ctx.onInvalidated(() => {
      cleanup();
    });

    window.addEventListener("message", handleWindowMessage);

    port.onMessage.addListener((message: unknown) => {
      if (typeof message !== "object" || message === null) {
        return;
      }

      const typedMessage = message as { type?: string };
      if (typedMessage.type === "background:apply-state-snapshot") {
        sendToPage(
          createBridgeEnvelope(bridgeId, "bridge:apply-remote", {
            message: message as ApplyRemotePlaybackMessage,
          }),
        );
        return;
      }

      if (typedMessage.type === "background:query-player-state") {
        sendToPage(
          createBridgeEnvelope(bridgeId, "bridge:query-player-state", {
            message: message as QueryPlayerStateMessage,
          }),
        );
      }
    });

    port.onDisconnect.addListener(() => {
      portDisconnected = true;
      cleanup();
    });

    sendInit();
    handshakeIntervalId = window.setInterval(() => {
      if (pageReady) {
        return;
      }

      sendInit();
    }, 600);
  },
});
