# Chrome Web Store

This project already produces the Chrome submission archive:

- `roll-together-extension-<version>-chrome.zip`

That same Chrome build works for Chrome and other Chromium-based browsers such as Brave, Edge, and Vivaldi.

## First-Time Store Setup

The first Chrome Web Store submission is still easiest to do manually.

Use the developer dashboard to:

1. create the item
2. upload the Chrome ZIP
3. fill in store listing details
4. complete privacy disclosures
5. set distribution and visibility
6. submit for review

After the first submission, you will have the identifiers needed for automation.

## GitHub Release Automation

The release workflow can also upload new Chrome builds to the Chrome Web Store if you configure Chrome Web Store API access.

The workflow expects:

- repository variable `CWS_EXTENSION_ID`
- repository variable `CWS_PUBLISHER_ID`
- repository variable `CWS_AUTO_PUBLISH`
- repository secret `CWS_SERVICE_ACCOUNT_KEY`

### Recommended setup

Use a Google Cloud service account for CI publishing.

At a high level:

1. enable the Chrome Web Store API in Google Cloud
2. create a service account
3. create a JSON key for that service account
4. link that service account to your Chrome Web Store developer account
5. add the JSON key to GitHub as `CWS_SERVICE_ACCOUNT_KEY`
6. add your publisher ID and extension ID as repository variables

If `CWS_AUTO_PUBLISH` is set to `true`, release tags will both upload and publish the new package.

If `CWS_AUTO_PUBLISH` is empty or not `true`, the workflow will upload the package only, which is safer while you are still tuning the listing and review flow.

## Good default release flow

1. bump the version in `package.json` and `wxt.config.ts`
2. commit the release
3. tag it, for example `v4.3.1`
4. push the branch and tag
5. let GitHub Actions build the release assets
6. let the workflow upload the Chrome ZIP to the store if the Chrome Web Store credentials are configured

## References

- Chrome Web Store API overview: <https://developer.chrome.com/docs/webstore/api>
- Service account setup: <https://developer.chrome.com/docs/webstore/service-accounts>
- Item API reference: <https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items>
- Upload API reference: <https://developer.chrome.com/docs/webstore/api/reference/rest/v2/media/upload>
