# Extension Architecture

## Overview

The extension is split into a few small layers:

- `entrypoints/`
  Background worker, popup UI, options page, and content script entrypoints.
- `src/core/`
  Shared protocol types, storage helpers, URL helpers, and sync logic.
- `src/providers/`
  Site-specific player detection and episode metadata handling.
- `src/platform/`
  Browser wrappers used by the extension runtime.
- `src/ui/`
  Shared theme tokens and UI helpers.

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
