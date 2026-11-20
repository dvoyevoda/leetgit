# Deploy the GitHub App companion

This optional Cloudflare Worker lets users connect in the browser without creating or pasting a personal access token. The Worker authorizes the user through the GitHub App and uses repository-scoped installation tokens to write files. Cloudflare D1 stores authorization state and revocable sessions.

## Register the GitHub App

1. Choose the Worker’s HTTPS origin, such as `https://leetrelay.YOUR-SUBDOMAIN.workers.dev`. Load the unpacked extension, then copy the ID shown on its card at `chrome://extensions`.
2. [Register a GitHub App](https://github.com/settings/apps/new) with the origin as the homepage. Set the **Callback URL** to `APP_ORIGIN/auth/callback` and the **Setup URL** to `APP_ORIGIN/auth/install`. Replace `APP_ORIGIN` with the full HTTPS origin. Enable **Redirect on update**.
3. Leave **Request user authorization (OAuth) during installation**, **Enable Device Flow**, and **Webhook → Active** unchecked. LeetRelay starts the authorization flow when the user connects.
4. Give the app only **Repository permissions → Contents → Read and write**, plus the mandatory read-only **Metadata** permission. **Only on this account** is enough for personal use. To allow other users to install it, choose **Any account**. [GitHub’s app registration guide](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)
5. From the registered app’s settings, note its slug and **Client ID**, generate a **Client secret**, and generate a **Private key**. Keep the client secret and downloaded PEM out of Git and the extension.

## Configure and deploy the Worker

Run these commands from the `worker/` directory. Choose the Cloudflare account that will host the companion.

```sh
npx wrangler login
npx wrangler d1 create leetrelay
```

In `wrangler.toml`, set `database_id` to the returned D1 ID, keep its `DB` binding, and use the same `database_name` as in the create command. Set these Worker variables in the same file.

| Variable | Value |
| --- | --- |
| `APP_ORIGIN` | Full HTTPS origin used in the app registration, without a trailing slash |
| `GITHUB_APP_SLUG` | Slug from the app’s GitHub settings |
| `GITHUB_CLIENT_ID` | Client ID from the app settings |
| `EXTENSION_IDS` | Exact Chrome extension IDs permitted to connect, separated by commas |

```sh
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put GITHUB_PRIVATE_KEY < /path/to/github-app.private-key.pem
```

Paste the client secret at Wrangler’s prompt. Each secret upload deploys a new Worker version. Confirm the deployed origin matches the GitHub callback and setup URLs before connecting. [D1 migration commands](https://developers.cloudflare.com/d1/wrangler-commands/#d1-migrations-apply) · [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

## Connect and verify

1. Set the deployed Worker origin in `extension/config.js`. Reload the extension at `chrome://extensions`, then open LeetRelay, click **Connect with GitHub**, and allow access to that Worker origin when Chrome asks.
2. On GitHub, install the App on your personal account, choose **Only select repositories**, select one initialized repository, and complete authorization. The companion checks the installation and repository before issuing a session.
3. Follow the [live test steps](../README.md#verify-with-a-previous-solution). For a public rollout, test installation with a second GitHub account and confirm installations selecting multiple repositories cannot connect.

Sessions expire after 90 days. Use the extension’s disconnect action to revoke its session or uninstall the GitHub App in GitHub settings to revoke its repository access.
