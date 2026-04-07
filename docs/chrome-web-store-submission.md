# Chrome Web Store Submission Guide

Use this page as a paste-ready reference when filling in the Chrome Web Store listing.

## Product Details

### Suggested description

Roll Together lets people watch supported streaming episodes together in sync, without requiring accounts.

The extension creates or joins shared rooms so viewers can play, pause, seek, and move between episodes together. It also keeps local watch progress, recent room shortcuts, theme settings, and backend settings inside the extension.

Roll Together is designed around self-hosting. The extension can connect to a local or user-managed backend server for room coordination, instead of forcing a centralized account system.

### Category

- `Entertainment`

### Language

- `English`

## URLs

If you do not have a dedicated marketing site yet, these are good defaults:

- Official site URL:
  - `https://github.com/punkrock34/roll_together`
- Support URL:
  - `https://github.com/punkrock34/roll_together/issues`
- Privacy policy URL:
  - host [privacy-policy.md](privacy-policy.md) on your own domain or GitHub Pages, then use that public URL

## Screenshots

Recommended first screenshots:

1. Popup on a supported episode page with an active connected room.
2. Popup `Rooms` tab showing saved rooms and participant list.
3. Popup `Settings` tab showing backend and theme controls.
4. Options page showing local room history and progress.

Try to avoid screenshots that only show an unsupported page or an empty state.

## Privacy And Permissions

### Single purpose

Creates and joins synchronized watch rooms on supported streaming pages so participants can watch the same episode together in real time.

### Storage justification

Uses browser storage to save local settings such as backend URLs, display name, theme, recent rooms, and watched progress so the extension can reconnect rooms and preserve user preferences.

### Tabs justification

Uses the active tab to read the current supported episode URL and title, open or rejoin room links in the right tab, and follow room-driven episode changes.

### Host permissions justification

Needs access to supported streaming pages on `crunchyroll.com` so it can detect the player, identify the active episode, and synchronize playback only on pages the user is actively watching.

### Remote code

- Select `No, I do not use remote code`

Reason:

Roll Together does not download and execute remote JavaScript or Wasm. Backend communication uses normal network data for room state and playback sync, which is not remote hosted code.

## Data Usage

Recommended disclosures to select:

- `Date cu caracter personal`
  - because the extension stores and can transmit a user-chosen display name for room presence
- `Istoric web`
  - because the extension reads the supported episode URL and domain to join, reconnect, and sync rooms
- `Conținutul site-ului`
  - because the extension reads the current episode title and player state needed for sync

Usually do not select categories such as payments, health, authentication, location, or personal communications for the current extension behavior.

### Data handling statement

Use this understanding consistently in the listing and privacy policy:

- data is used only to provide room synchronization and local extension features
- local settings, saved rooms, and watch progress are stored in browser storage
- room data is sent only to the backend server configured by the user or packager
- data is not sold and is not used for advertising

## Notes

- If the store form asks whether the extension uses remote code, the correct answer for the current codebase is `No`.
- If you change supported providers or add analytics, chat logs, accounts, or cloud persistence later, revisit both the data usage section and the privacy policy before publishing.
