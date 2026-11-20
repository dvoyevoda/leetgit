# LeetGit

LeetGit is a Chrome extension that saves your accepted LeetCode submissions to one GitHub repository. It uses your existing LeetCode session and does not ask for your LeetCode password.

## Install on Chrome

1. Download the Chrome ZIP and extract it. [Latest LeetGit release](https://github.com/dvoyevoda/leetgit/releases/latest)
2. Open `chrome://extensions` in Chrome and turn on **Developer mode**.
3. Click **Load unpacked** and select the `extension` folder containing `manifest.json`.
4. Open LeetGit from Chrome’s Extensions menu. Reload any LeetCode tabs that were already open. [Chrome’s extension installation guide](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked)

If you already installed LeetGit, copy the new files into the same unpacked `extension` folder. Follow the same steps if your installed version still says LeetRelay. Keep your `config.js` if you configured a GitHub App companion. Click **Reload** on the extension’s card in `chrome://extensions`, then refresh any open LeetCode tabs. Updating in place preserves your saved repository connection.

## Connect one repository

Create or choose a GitHub repository for your solutions. Initialize a new repository with a README so it has a default branch. You can keep the solutions repository private, even if LeetGit’s source is public.

1. Paste the GitHub repository URL or enter `owner/repository`, then click **Create GitHub token**. The button pre-fills the resource owner, a 90-day expiration, and **Contents → Read and write**. [Fine-grained token form](https://github.com/settings/personal-access-tokens/new?name=LeetGit&expires_in=90&contents=write)
2. Choose the repository’s owner under **Resource owner**. Under **Repository access**, select **Only select repositories** and choose exactly one repository. Check the permission list before generating the token. GitHub adds read-only **Metadata** automatically. [GitHub’s token guide](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token)
3. Copy the token beginning with `github_pat_`, paste it into LeetGit, and click **Connect repository**. Repeat the setup with a new token when it expires.

The popup remembers the repository field when you close it. An unfinished token stays in Chrome’s extension memory until you finish setup or close Chrome.

For a button-based setup without copying a token, a maintainer can deploy the optional [GitHub App companion](worker/DEPLOY.md). During GitHub installation, choose **Only select repositories** and select exactly one repository.

## What gets saved

Each accepted submission updates a problem folder and its README in one Git commit. With the LeetCode problem number, Two Sum is saved in `solutions/1-two-sum/` alongside a source file such as `python3.py`. A previously saved slug-only folder moves to the numbered name on its next sync when the number is available and the destination is free. The README includes the problem link, available difficulty and topics, a source preview, and the latest accepted results per language. Runtime, memory, percentiles, and test counts appear when LeetCode supplies them. Add your own notes outside the generated section to keep them across updates.

The README includes the full visible text of non-premium problems by default when LeetCode supplies it. In **Settings**, turn off **Include full problem text** to use the short overview and official link. Use the full text option where you have permission to share the description. [LeetCode Terms of Service](https://leetcode.com/terms/)

## Verify with a previous solution

1. In your signed-in Chrome window, open a previously solved problem on `leetcode.com`.
2. In its **Submissions** tab, open an **Accepted** submission. Put that exact solution in the editor and choose the same language.
3. Click **Submit** and wait for the **Saved to GitHub** or **Updated on GitHub** message. The Chrome toolbar shows a green check on that problem after a successful sync. Navigate to an unsynced problem and it clears.
4. Open the problem README from the popup or the on-page message. Check the results and confirm the source file matches what you submitted. A fresh resubmission can update the results even when its code is identical. Resubmit earlier solves to add READMEs for them.

Open the LeetGit popup to see status for the problem in the active LeetCode tab. If a sync fails, correct the reported issue and click **Retry now**. Other queued syncs can be retried from **Settings**.

## Data and access

In token mode, Chrome stores the token locally and LeetGit sends submissions and the token directly to the GitHub API. GitHub enforces the token’s scope, so select exactly one repository when generating the token. LeetGit cannot inspect the full grant list. GitHub fine-grained tokens also have read access to public repositories. You can revoke yours in [personal access token settings](https://github.com/settings/personal-access-tokens). GitHub App mode sends the submitted source through the configured companion on its way to GitHub.

## Development

Run `npm test` from the project root with Node.js 22 or newer. The extension itself has no build step. Use Chrome’s [extension debugging guide](https://developer.chrome.com/docs/extensions/get-started/tutorial/debug) to inspect the extension after making edits.

## License and credit

LeetGit is independently written and released under the [MIT License](LICENSE). The idea was inspired by [LeetSync](https://github.com/LeetSync/LeetSync).
