# SolveToGit privacy policy

Last updated November 21, 2026.

SolveToGit saves accepted LeetCode submissions to one GitHub repository you choose. This policy covers the Chrome Web Store release and identifies how the optional self-hosted companion differs.

## Information SolveToGit handles

- **Connection details.** SolveToGit keeps the destination repository’s name, ID, and visibility. The Store release uses the fine-grained GitHub token you create and enter during setup. It uses that token to verify the destination and write commits on your behalf.
- **LeetCode page and submission data.** On supported `leetcode.com` pages, SolveToGit reads the current problem context and observes submission requests and judge results. It processes the submitted source, language, submission ID, problem and submission links, acceptance time, and available runtime, memory, percentile, and test results. It uses available problem metadata and text to create the README. It saves and sends accepted submissions when a repository is connected.
- **Local sync information.** SolveToGit holds queued submissions, retry state, settings, and per-problem sync results in Chrome. It uses the active LeetCode problem to show the corresponding popup and toolbar status.

## Storage and sharing

The Store release keeps the connected token and sync information in local Chrome extension storage. An unfinished token stays in Chrome’s extension session memory. SolveToGit sends the token over HTTPS to GitHub’s API. It sends accepted submission data directly to the selected GitHub repository over the same API to create the solution commit. Your GitHub repository’s visibility and access settings determine who can see the committed files. A public destination makes the committed code and README public. Full visible problem text is included by default when available for non-premium problems. Choose where you have permission to share that text. [GitHub Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement) · [LeetCode Terms of Service](https://leetcode.com/terms/)

SolveToGit uses and shares this information only to provide the requested sync. User data is excluded from advertising, sale, and creditworthiness use. SolveToGit’s handling of information received from Chrome APIs adheres to the Chrome Web Store User Data Policy, including its Limited Use requirements. [Chrome Web Store Limited Use requirements](https://developer.chrome.com/docs/webstore/program-policies/limited-use)

## Deletion and choices

- Use **Settings → Disconnect** to clear the saved connection, queued submissions, and local sync results. Removing the extension clears its Chrome extension storage.
- Revoke the fine-grained token in GitHub to stop it from authorizing future requests. [GitHub token settings](https://github.com/settings/personal-access-tokens)
- Turn off **Include full problem text** in Settings to use short overviews in future synced READMEs. GitHub retains existing commits according to its repository features and policies. Manage existing files and history in GitHub.

## Optional self-hosted companion

If you install the separate unpacked edition and configure a GitHub App companion, your browser sends sync requests to the chosen companion’s HTTPS origin. That service forwards the accepted submission data to GitHub and stores session metadata for authorization, including hashed session credentials and installation and repository identifiers. The companion expires setup flows and sessions. The operator manages service settings and hosting. The Chrome Web Store release uses the direct GitHub token path.

## Contact

SolveToGit is maintained by `@dvoyevoda`. For privacy questions, use GitHub Issues with a general description. Keep credentials, private repository details, and source code out of public reports. [Contact the maintainer](https://github.com/dvoyevoda/solvetogit/issues/new)
