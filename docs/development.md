# Extension Development

## Requirements

- Node.js 20+
- npm 10+

## Install

```bash
npm install
```

## Local Environment

Create a local `.env` if you want to override the default backend endpoints baked into development builds.

```bash
cp .env.example .env
```

Defaults point at:

- `http://localhost:3000`
- `ws://localhost:3000/ws`

## Development

Chrome build/watch:

```bash
npm run dev:chrome
```

Firefox build/watch:

```bash
npm run dev:firefox
```

## Production Builds

```bash
npm run build
```

Package archives:

```bash
npm run zip
```

## Checks

```bash
npm run check
npm run lint
npm run test
```

## Manual Smoke Test

1. Start the backend from the sibling backend repository.
2. Load the unpacked extension build in Chrome or Firefox.
3. Open the same supported episode in two browser windows.
4. Create a room in one window and open the room link in the other.
5. Verify play, pause, seek, and episode switching.
6. Verify room history and backend settings from the popup.
