# Roll Together v2 Extension

Roll Together v2 is a maintained continuation of the original Roll Together browser extension. It keeps the anonymous watch-party model, stays focused on browser extensions, and is being rebuilt to be easier to maintain, easier to self-host, and friendlier to Firefox and Chrome.

## Project Lineage

This project continues the work started by SamuraiExx on the original [`roll_together`](https://github.com/samuraiexx/roll_together) and [`roll_together_backend`](https://github.com/samuraiexx/roll_together_backend) repositories. The original work remains MIT-licensed, and this repository keeps that license and attribution intact while evolving the codebase into a more maintainable v2.

The original README has been preserved in [README.legacy.md](README.legacy.md).

## What v2 Changes

- WXT-based build pipeline with generated manifests for Chrome and Firefox.
- Browser-extension-first architecture with isolated provider, sync, and storage layers.
- Local-first watched-progress tracking stored in the extension.
- Configurable backend URLs for local development and self-hosting.
- Cleaner popup and options flows focused on anonymous rooms and room sharing.

## Current Scope

v2 intentionally stays:

- Crunchyroll-first.
- Anonymous, with no mandatory accounts.
- Split into two repositories: extension frontend and backend.

v2 intentionally does not include full chat yet. Stable sync, reconnect behavior, better room UX, and simple self-hosting come first.

## Development

### Prerequisites

- Node.js 20+
- npm 10+

### Install

```bash
npm install
```

### Run in Development

```bash
npm run dev:chrome
npm run dev:firefox
```

### Build

```bash
npm run build
```

### Package ZIPs

```bash
npm run zip
```

### Quality Checks

```bash
npm run lint
npm run check
npm run test
```

## Local Backend Configuration

Create a local `.env` file from `.env.example` if you want to override the default backend endpoints used by the extension build.

```bash
cp .env.example .env
```

Defaults target a backend running on `http://localhost:3000`.

## Architecture Overview

- `entrypoints/`
  Runtime entrypoints for the extension background, popup, options page, and Crunchyroll content script.
- `src/core/`
  Shared room protocol types, storage helpers, room-link helpers, and sync reconciliation logic.
- `src/providers/crunchyroll/`
  Crunchyroll-specific player detection and episode metadata extraction.
- `src/platform/`
  Browser/runtime wrappers.
- `src/ui/`
  Shared visual tokens for extension surfaces.

## Manual Smoke Test

1. Start the backend from the sibling backend repository.
2. Run `npm run dev:chrome`.
3. Load the generated Chrome build as an unpacked extension.
4. Open the same Crunchyroll episode in two browser windows.
5. Create a room in window one and open the shared link in window two.
6. Verify play, pause, and seek sync.
7. Verify watched progress appears in the options page.

## Browser Support Notes

- Chrome/Chromium: Manifest V3 background service worker flow.
- Firefox: MV3 packaging with explicit Gecko metadata for signing and distribution.

## Related Repositories

- Backend: sibling `roll_together_backend` repo in this workspace
- Original backend: https://github.com/samuraiexx/roll_together_backend
