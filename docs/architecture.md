# Extension Architecture

## Overview

The extension is split into a few small layers:

- `entrypoints/`
  Background worker, popup UI, options page, isolated content bridge, and page-context content entrypoints.
- `src/core/`
  Shared protocol types, storage helpers, URL helpers, and sync logic.
- `src/providers/`
  Site-specific player detection, page adapter control logic, and provider bridge message contracts.
- `src/platform/`
  Browser wrappers used by the extension runtime.
- `src/ui/`
  Shared theme tokens and UI helpers.

## Crunchyroll Integration Model

- The background worker remains the authoritative room sync layer.
- `entrypoints/crunchyroll.content.ts` runs in the isolated world and only handles transport:
  - `runtime.connect` with the background.
  - `window.postMessage` bridge to the page world.
- `entrypoints/crunchyroll-page.content.ts` runs in `world: "MAIN"` and owns player control/sampling through the provider adapter.
- Message flow is now:
  - `Backend <-> Background <-> Isolated Content Bridge <-> Page Script <-> Crunchyroll Player`

## Room Model

- Rooms are anonymous.
- The current host is authoritative for playback and episode changes.
- Followers receive playback corrections and room-preserving episode navigation.
- Session identity is kept locally so reconnects and same-tab navigation can restore a room cleanly.

## Local Storage

The extension stores:

- backend HTTP and WebSocket URLs
- theme preference
- recent room shortcuts
- watched-progress snapshots

Everything stays local to the browser profile.
