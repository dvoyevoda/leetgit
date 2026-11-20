import { workerOrigin } from './config.js';
import { expectJson, normalizeRepositoryName, request, SyncError } from './github.js';

export async function appRequest(path, token, method = 'GET', data) {
  const headers = { Authorization: `Bearer ${token}` };
  if (data) headers['Content-Type'] = 'application/json';
  return request(`${workerOrigin}${path}`, { method, headers, body: data && JSON.stringify(data) });
}

export async function connectApp() {
  if (!workerOrigin) throw new SyncError('GitHub App setup is unavailable in this build.');
  const callback = chrome.identity.getRedirectURL('github');
  const state = crypto.randomUUID();
  const start = new URL('/auth/start', workerOrigin);
  start.search = new URLSearchParams({ redirect_uri: callback, state });
  let url;
  try {
    url = new URL(await chrome.identity.launchWebAuthFlow({ url: start.href, interactive: true }));
  } catch {
    throw new SyncError('GitHub setup was closed. Open LeetRelay to try again.');
  }
  const hash = url.hash;
  url.hash = '';
  const params = new URLSearchParams(hash.slice(1));
  const token = params.get('token');
  if (url.href !== callback || params.get('state') !== state) {
    throw new SyncError('GitHub setup could not be verified. Try reconnecting.');
  }
  const error = params.get('error');
  if (error) throw new SyncError(error.slice(0, 400));
  if (!/^[\w-]{32,160}$/.test(token ?? '')) throw new SyncError('GitHub setup did not return a session.');
  const result = await expectJson(await appRequest('/session', token), 'GitHub App');
  if (!Number.isSafeInteger(result.repository?.id) || result.repository.id < 1) {
    throw new SyncError('GitHub App returned an invalid repository identity.');
  }
  return {
    mode: 'app', token, origin: workerOrigin,
    repository: {
      id: result.repository.id,
      fullName: normalizeRepositoryName(result.repository.fullName),
      private: result.repository.private === true,
    },
  };
}
