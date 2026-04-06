# Roll Together Extension

![CI](https://github.com/punkrock34/roll_together/actions/workflows/ci.yml/badge.svg)
![License](https://img.shields.io/badge/license-MIT-green)
![Status](https://img.shields.io/badge/status-active-blue)

Roll Together is a self-hostable browser extension that lets you watch content in sync with others — no accounts, no central servers, full control.

This repository contains the extension frontend.

---

## Why This Exists

This project continues the original Roll Together extension after its retirement.

The goal is to keep the idea alive while improving maintainability, self-hosting, and extensibility.

---

## Attribution

This project continues work originally published by SamuraiExx in:

- <https://github.com/samuraiexx/roll_together>
- <https://github.com/samuraiexx/roll_together_backend>

The original work remains MIT-licensed, and that attribution stays part of this continuation.

Thank you to SamuraiExx for building the original project and releasing it openly.

The original extension README is preserved in [README.legacy.md](README.legacy.md).

---

## What This Repo Covers

- browser extension runtime for Chrome and Firefox
- anonymous room creation and synchronization
- local room history and watched progress
- backend configuration and theme settings inside the extension

---

## Changes in This Fork

- refactored codebase for maintainability
- improved self-hosting support
- separated extension and backend responsibilities
- ongoing improvements and feature exploration

---

## Quick Start

```bash
npm install
npm run dev:chrome
```

For Firefox:

```bash
npm run dev:firefox
```

---

## Docs

- [Development guide](docs/development.md)
- [Architecture notes](docs/architecture.md)
- [Release guide](docs/releases.md)
- [Chrome Web Store notes](docs/chrome-web-store.md)

---

## License

MIT — see [LICENSE](./LICENSE)
