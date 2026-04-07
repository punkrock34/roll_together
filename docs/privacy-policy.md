# Roll Together Privacy Policy

Last updated: 2026-04-07

This privacy policy describes how the Roll Together browser extension handles data.

## Summary

Roll Together is designed to help people watch supported streaming episodes together in sync.

The extension stores some settings and history locally in the browser. When room sync is used, the extension sends room and playback data to the backend server configured for that installation.

Roll Together does not require accounts.

## Data the extension handles

The extension may handle the following categories of data:

- a user-chosen display name used for room presence
- backend connection settings such as the configured HTTP and WebSocket server URLs
- saved room links and labels
- local watch progress for supported episodes
- the current supported episode URL and title
- playback state needed for sync, such as current time, paused or playing state, playback rate, and episode transitions

## How data is used

The extension uses this data to:

- create and join shared watch rooms
- synchronize playback between room participants
- reconnect to rooms after page changes or refreshes
- show participant presence in the extension UI
- save local settings and watch progress inside the browser

## Where data is stored

Roll Together stores settings, saved rooms, labels, theme preferences, and watch progress in the browser's local extension storage.

## Backend communication

When room features are used, the extension communicates with a backend server over HTTP and WebSocket connections.

That communication can include:

- room identifiers
- participant display names
- participant presence information
- episode URLs and titles
- playback state and timing data required for synchronization

The extension is intended to work with a local or self-hosted backend by default, but the backend URL can be changed by the user or packager.

If you configure the extension to use a third-party backend, the data listed above will be sent to that backend while room features are active.

## Data sharing

Roll Together does not sell user data.

Roll Together does not use user data for advertising or profiling.

Room and playback data is shared only with:

- the configured backend server
- other participants in the same room as needed to provide the room synchronization feature

## Data retention

Local settings, saved rooms, and watch progress remain in browser storage until the user changes them, clears them, or removes the extension.

Backend-side retention depends on the backend deployment being used. A local or self-hosted backend may keep only short-lived in-memory room state, but that depends on how the backend operator configures and runs it.

## Security

If a remote backend is used, HTTPS and WSS should be used to protect data in transit.

## Your choices

Users can:

- change the backend server from the extension settings
- change the display name used in rooms
- clear saved room history and watch progress
- remove the extension to delete locally stored extension data

## Contact and support

Project support is available through the repository issue tracker:

<https://github.com/punkrock34/roll_together/issues>
