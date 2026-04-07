# Extension Releases

This repository can publish browser release assets through GitHub Releases.

For Chrome Web Store publishing details, see [chrome-web-store.md](chrome-web-store.md).

## What the release workflow does

When you push a tag like `v4.3.2`, GitHub Actions will:

1. install dependencies
2. run lint, typecheck, and tests
3. build Chrome and Firefox archives
4. create or update a GitHub Release for that tag
5. upload release assets to GitHub
6. optionally sync the Chrome package to the Chrome Web Store

Uploaded by default:

- `roll-together-extension-<version>-chrome.zip`
- `roll-together-extension-<version>-firefox.zip`
- `roll-together-extension-<version>-sources.zip`

If AMO signing secrets are configured, the workflow also uploads:

- `roll-together-extension-<version>-firefox-signed.xpi`

That signed `.xpi` is the file you can share directly with Firefox users for self-distribution.

If Chrome Web Store variables and secrets are configured, the workflow can also upload the Chrome ZIP to the Chrome Web Store.

## GitHub repository secrets

If you want the workflow to produce a signed Firefox `.xpi`, add these repository secrets:

- `AMO_API_KEY`
- `AMO_API_SECRET`

You can create them from your AMO API credentials page:

<https://addons.mozilla.org/developers/addon/api/key/>

Mozilla signing reference:

<https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/>

If you want Chrome Web Store upload automation, also configure:

- repository variable `CWS_EXTENSION_ID`
- repository variable `CWS_PUBLISHER_ID`
- repository variable `CWS_AUTO_PUBLISH`
- repository secret `CWS_SERVICE_ACCOUNT_KEY`

## Release steps

1. Bump the extension version in:
   - `package.json`
   - `wxt.config.ts`
2. Commit the version bump.
3. Create a tag that matches the package version:

```bash
git tag v4.3.2
git push origin main --tags
```

The workflow checks that the tag matches `package.json`. A mismatch fails the release job on purpose.

## Manual runs

You can also run the workflow manually from GitHub Actions.

If you do, it creates or updates a release using the current `package.json` version as the tag name, for example `v4.3.2`.

## Sharing with users

Recommended sharing options:

- Chrome/Brave/Edge users: send the Chrome ZIP or unpacked build instructions.
- Firefox users: send the signed `.xpi` from the GitHub Release if AMO signing is enabled.

If AMO signing secrets are not configured, the release still contains the Firefox submission ZIP, but that file is not a direct install file for standard Firefox.

Chrome Web Store syncing is best-effort. If Chrome auth or upload fails, the workflow still creates the GitHub Release and uploads the browser artifacts there.
