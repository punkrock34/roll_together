import { defineConfig } from "wxt";

const crunchyrollMatches = ["*://crunchyroll.com/*", "*://*.crunchyroll.com/*"];

export default defineConfig({
  manifestVersion: 3,
  modules: [],
  manifest: ({ browser, mode }) => ({
    name:
      mode === "development" ? "Roll Together v2 (Dev)" : "Roll Together v2",
    short_name: "Roll Together",
    description:
      "Anonymous Crunchyroll watch parties with local-first progress and a self-hosted backend.",
    version: "4.2.3",
    permissions: ["storage", "tabs"],
    host_permissions: crunchyrollMatches,
    minimum_chrome_version: "116",
    browser_specific_settings:
      browser === "firefox"
        ? {
            gecko: {
              id: "roll-together-v2@rolltogether.app",
              strict_min_version: "140.0",
              data_collection_permissions: {
                required: ["none"],
              },
            },
            gecko_android: {
              strict_min_version: "142.0",
            },
          }
        : undefined,
    action: {
      default_title: "Roll Together v2",
      default_popup: "popup.html",
    },
    options_ui: {
      page: "options.html",
      open_in_tab: true,
    },
    icons: {
      "16": "images/get_started16.png",
      "32": "images/get_started32.png",
      "48": "images/get_started48.png",
      "128": "images/get_started128.png",
    },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self';",
    },
  }),
});
