# LeetGit

LeetGit is a Chrome extension that saves your accepted LeetCode submissions to one GitHub repository. It uses your existing LeetCode session and does not ask for your LeetCode password.

## Install on Chrome

1. Download the Chrome ZIP and extract it. [Latest LeetGit release](https://github.com/dvoyevoda/leetgit/releases/latest)
2. Open `chrome://extensions` in Chrome and turn on **Developer mode**.
3. Click **Load unpacked** and select the `extension` folder containing `manifest.json`.
4. Open LeetGit from Chrome’s Extensions menu. Reload any LeetCode tabs that were already open. [Chrome’s extension installation guide](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked)

If you already installed v0.1.0 under the LeetRelay name, copy the new files into the same unpacked `extension` folder. Keep your `config.js` if you configured a GitHub App companion. Click **Reload** on the extension’s card in `chrome://extensions`, then refresh any open LeetCode tabs. Updating in place preserves your saved repository connection.

## Connect one repository

Create or choose a GitHub repository for your solutions. Initialize a new repository with a README so it has a default branch. You can keep the solutions repository private, even if LeetGit’s source is public.

1. Enter `owner/repository` in LeetGit and click **Create GitHub token**. The [fine-grained token form](https://github.com/settings/personal-access-tokens/new?name=LeetGit&expires_in=90&contents=write) pre-fills a 90-day expiration and **Contents → Read and write**. LeetGit’s button also pre-fills the resource owner.
2. Choose the repository’s owner under **Resource owner**. Under **Repository access**, select **Only select repositories** and choose exactly one repository. Check the permission list before generating the token. GitHub adds read-only **Metadata** automatically. [GitHub’s token guide](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token)
3. Copy the token beginning with `github_pat_`, paste it into LeetGit, and click **Connect repository**. Repeat the setup with a new token when it expires.

For a button-based setup without copying a token, a maintainer can deploy the optional [GitHub App companion](worker/DEPLOY.md). During GitHub installation, choose **Only select repositories** and select exactly one repository.

## Verify with a previous solution

1. In your signed-in Chrome window, open a previously solved problem on `leetcode.com`.
2. In its **Submissions** tab, open an **Accepted** submission. Put that exact solution in the editor and choose the same language.
3. Click **Submit** once and wait for LeetCode to mark it **Accepted**. If the same code already exists in the destination, use a different accepted solution so you can verify a new commit.
4. Check the connected repository’s default branch for the new commit and confirm the file matches the submitted source. LeetGit stores one file per problem and language, for example `solutions/two-sum/python3.py`. Resubmitting identical source leaves the file unchanged. The new submission still appears in your LeetCode history.

Open the LeetGit popup to check sync status. If a sync fails, correct the reported issue and click **Retry now**.

## Data and access

In token mode, Chrome stores the token locally and LeetGit sends submissions and the token directly to the GitHub API. GitHub enforces the token’s scope, so select exactly one repository when generating the token. LeetGit cannot inspect the full grant list. GitHub fine-grained tokens also have read access to public repositories. You can revoke yours in [personal access token settings](https://github.com/settings/personal-access-tokens). GitHub App mode sends the submitted source through the configured companion on its way to GitHub.

## Development

Run `npm test` from the project root with Node.js 22 or newer. The extension itself has no build step. Use Chrome’s [extension debugging guide](https://developer.chrome.com/docs/extensions/get-started/tutorial/debug) to inspect the extension after making edits.

## License and credit

LeetGit is independently written and released under the [MIT License](LICENSE). The idea was inspired by [LeetSync](https://github.com/LeetSync/LeetSync).
