import {
  isBridgeEnvelope,
  isContentToPageMessage,
  type BridgePageToContentMessage,
} from "../src/providers/crunchyroll/bridge-messages";
import {
  createCrunchyrollPageController,
  type CrunchyrollPageController,
} from "../src/providers/crunchyroll/page-controller";

const GLOBAL_CONTROLLER_KEY = "__ROLL_TOGETHER_CRUNCHYROLL_PAGE_BRIDGE__";

interface WindowWithPageBridge extends Window {
  [GLOBAL_CONTROLLER_KEY]?: {
    cleanup: () => void;
  };
}

function postToContent(message: BridgePageToContentMessage) {
  window.postMessage(message, "*");
}

export default defineContentScript({
  matches: ["*://crunchyroll.com/*", "*://*.crunchyroll.com/*"],
  allFrames: false,
  world: "MAIN",
  runAt: "document_start",
  main() {
    const typedWindow = window as WindowWithPageBridge;
    typedWindow[GLOBAL_CONTROLLER_KEY]?.cleanup();

    let bridgeId: string | undefined;
    let controller: CrunchyrollPageController | undefined;

    const cleanup = () => {
      window.removeEventListener("message", handleWindowMessage);
      controller?.cleanup();
      controller = undefined;
      bridgeId = undefined;

      if (typedWindow[GLOBAL_CONTROLLER_KEY]?.cleanup === cleanup) {
        delete typedWindow[GLOBAL_CONTROLLER_KEY];
      }
    };

    const handleWindowMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== window) {
        return;
      }

      if (!isBridgeEnvelope(event.data)) {
        return;
      }

      if (
        bridgeId &&
        event.data.type === "bridge:init" &&
        event.data.bridgeId !== bridgeId
      ) {
        controller?.cleanup();
        bridgeId = event.data.bridgeId;
        controller = createCrunchyrollPageController({
          bridgeId,
          postMessage: postToContent,
        });
      }

      if (!bridgeId) {
        if (event.data.type !== "bridge:init") {
          return;
        }

        bridgeId = event.data.bridgeId;
        controller = createCrunchyrollPageController({
          bridgeId,
          postMessage: postToContent,
        });
      }

      if (!controller || !bridgeId) {
        return;
      }

      if (!isContentToPageMessage(event.data, bridgeId)) {
        return;
      }

      controller.handleBridgeMessage(event.data);
    };

    window.addEventListener("message", handleWindowMessage);
    typedWindow[GLOBAL_CONTROLLER_KEY] = {
      cleanup,
    };
  },
});
