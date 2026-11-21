# SolveToGit Chrome Web Store submission guide

This guide contains the listing copy, privacy disclosures, and reviewer walkthrough for the direct-to-GitHub Store build.

## Package

From the repository root, use Python 3 to create the ZIP. `manifest.json` is at the root of the resulting archive.

```sh
python3 scripts/build-store-zip.py /absolute/path/solvetogit-chrome-web-store-v0.3.0.zip
```

For a local check, extract that ZIP into a clean folder and load the folder containing `manifest.json` at `chrome://extensions`. Use a separate Chrome profile with a disposable GitHub repository for the first sync. [Chrome Web Store package requirements](https://developer.chrome.com/docs/webstore/prepare#zip-your-extension-files)

## Listing fields

| Field | Value |
| --- | --- |
| Title | SolveToGit - LeetCode to GitHub Sync |
| Category | Developer Tools |
| Language | English (United States) |
| Short description | Sync accepted LeetCode solutions to one GitHub repository you choose. |
| Website | `https://github.com/dvoyevoda/solvetogit` |
| Support | `https://github.com/dvoyevoda/solvetogit/issues` |
| Privacy policy | `https://github.com/dvoyevoda/solvetogit/blob/main/PRIVACY.md` |

### Description

SolveToGit automatically saves accepted LeetCode solutions to one GitHub repository you choose. It commits the exact submitted source and a formatted README together.

- Organize solves by problem number and language.
- Save the problem link, difficulty, and available runtime, memory, percentiles, and test results. The README includes available non-premium problem text by default. You can switch to an overview in Settings.
- See the sync result for the problem you’re viewing. The popup links straight to the source and README.
- Retry temporary failures from the local queue.

Connect a GitHub repository with a fine-grained token limited to that repository. The Store release keeps the token in Chrome’s local extension storage and sends it to GitHub’s API to authenticate. It reads supported LeetCode pages and submission responses to detect and process accepted solves, then sends accepted source, results, and available problem details directly to your chosen GitHub repository. Repository visibility determines who can see the commits.

Works with signed-in regular practice submissions on `leetcode.com`. Independent open-source project maintained by `@dvoyevoda`. [Source and support](https://github.com/dvoyevoda/solvetogit) · [Privacy policy](https://github.com/dvoyevoda/solvetogit/blob/main/PRIVACY.md)

### Graphics

Upload the supplied 1280 × 800 screenshots in this order. The examples use synthetic submission and repository data.

1. `01-saved-to-github.png`
2. `02-connect-one-repository.png`

Use `icon-128.png` for the listing icon and `small-promo-440x280.png` for the small promotional tile. [Chrome Web Store image requirements](https://developer.chrome.com/docs/webstore/images)

## Privacy practices

### Single purpose

> Automatically sync accepted LeetCode practice submissions and their results to one GitHub repository selected by the user.

### Permission justifications

| Permission or host | Justification |
| --- | --- |
| `storage` | Remembers the destination, GitHub token, setup drafts, settings, and retry queue. Saves per-problem status so the popup shows the current problem’s result. |
| `alarms` | Retries queued submissions after temporary sync failures, subject to backoff. |
| `https://api.github.com/*` | Checks the selected repository and writes source and README commits on the user’s behalf over HTTPS. |
| `https://leetcode.com/*` content scripts | Detects LeetCode practice pages and observes submission and judge responses. It runs at page start so it can observe submissions after client-side navigation to another problem. |

For the dashboard data categories, disclose the GitHub token under **Authentication information**, repository account identifiers under **Personally identifiable information**, the source, problem text, and results under **Website content**, and the observed submission and result under **User activity**. Disclose the limited LeetCode problem and submission URLs under **Web history**. The privacy policy explains why each is used, local storage, transfer to the chosen repository, and deletion controls. All extension JavaScript is included in the ZIP. GitHub API responses are used as data.

Use the public policy URL from the listing table. Review and confirm the Limited Use statements against the uploaded build when completing the dashboard. [Chrome Web Store privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)

## Test instructions for Google review

1. Use a signed-in LeetCode account and a GitHub account with an initialized disposable repository. A private repository works. The account needs permission to create commits on the default branch.
2. Open SolveToGit. Paste the disposable repository URL and click **Create GitHub token**. On GitHub, choose **Only select repositories**, select the disposable repository, and grant **Contents → Read and write**. Generate and paste the fine-grained token, then click **Connect repository**.
3. On `leetcode.com`, open a problem in the regular practice workspace and submit a known accepted solution. If the tab was open before installation, refresh it first.
4. After LeetCode returns **Accepted**, verify the **Saved to GitHub** notification and green toolbar check. The popup should show the current problem’s result and links. In the repository, confirm the source and problem README are in the same commit. The README should show available results and eligible problem text with the default setting.
5. Open the saved code or README from the popup. Then switch to a different unsynced practice problem and verify that the popup returns to **Ready to sync** without showing the previous problem’s stats.
6. Disconnect in Settings and revoke the review token in GitHub when finished.

If the reviewer needs credentials, provide disposable review-account details only in the dashboard’s private test instructions. [Chrome Web Store test instructions](https://developer.chrome.com/docs/webstore/cws-dashboard-test-instructions)

## Submission order

1. Sign into the Chrome Web Store Developer Dashboard with the publisher account and complete developer registration.
2. Upload the Store ZIP, enter the listing fields, add the supplied graphics, and complete the Privacy and Test instructions tabs.
3. Choose distribution and submit for review. Google offers private visibility for trusted testers and reviews private, unlisted, and public items. [Publishing guide](https://developer.chrome.com/docs/webstore/publish) · [Distribution options](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution)
