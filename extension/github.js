import { commitSubmission, GitCommitError } from './commit.js';
import { encodeRepository, normalizeRepositoryName } from './repository.js';

const api = 'https://api.github.com';

export class SyncError extends Error {
  constructor(message, { retry = false, retryAfter = 0 } = {}) {
    super(message);
    this.retry = retry;
    this.retryAfter = retryAfter;
  }
}

export async function request(url, options) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(15000), redirect: 'error' });
  } catch {
    throw new SyncError('Could not reach the sync service. Check the connection and retry.', { retry: true });
  }
}

export async function expectJson(response, service) {
  if (response.ok) return response.json();
  const { status } = response;
  const retryAt = Number(response.headers.get('X-RateLimit-Reset')) * 1000 - Date.now();
  const retryAfter = Number(response.headers.get('Retry-After')) * 1000;
  if (status === 429 || response.headers.get('X-RateLimit-Remaining') === '0' ||
      (status === 403 && retryAfter > 0)) {
    throw new SyncError(`${service} rate limit reached. SolveToGit will retry.`, {
      retry: true, retryAfter: Math.max(retryAt, retryAfter, 60000),
    });
  }
  if (status === 401) throw new SyncError(`${service} connection expired or was revoked. Reconnect to retry.`);
  if (status === 403 || status === 404) {
    throw new SyncError(`${service} could not access the destination. Check the repository selection and Contents write permission.`);
  }
  if (status === 409 || status === 422) {
    throw new SyncError(`${service} could not write the file. Check that the repository has a commit and its default branch allows direct writes.`, { retry: status === 409 });
  }
  throw new SyncError(`${service} returned HTTP ${status}.`, { retry: status >= 500 });
}

function githubRequest(path, token, { method = 'GET', body } = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return request(`${api}${path}`, {
    headers,
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function connectToken(name, input) {
  const token = String(input ?? '').trim();
  if (!/^github_pat_[a-zA-Z0-9_]{20,250}$/.test(token)) {
    throw new SyncError('Paste a fine-grained GitHub token beginning with github_pat_.');
  }
  let repoName;
  try {
    repoName = encodeRepository(name);
  } catch (error) {
    throw new SyncError(error.message);
  }
  const response = await githubRequest(`/repos/${repoName}`, token);
  const repo = await expectJson(response, 'GitHub');
  if (!Number.isSafeInteger(repo.id) || repo.id < 1 || !repo.default_branch ||
      typeof repo.default_branch !== 'string' || repo.archived || repo.disabled) {
    throw new SyncError('Choose an active GitHub repository with a default branch.');
  }
  if (repo.permissions?.push === false) {
    throw new SyncError('This GitHub account cannot push to the repository.');
  }
  return {
    mode: 'token', token,
    repository: { id: repo.id, fullName: normalizeRepositoryName(repo.full_name), private: repo.private === true },
  };
}

export async function syncToken(connection, submission) {
  const { repository, token } = connection;
  const repoPath = `/repos/${encodeRepository(repository.fullName)}`;
  const repo = await expectJson(await githubRequest(repoPath, token), 'GitHub');
  if (repo.id !== repository.id || repo.private !== repository.private || repo.archived || repo.disabled ||
      typeof repo.default_branch !== 'string' || !repo.default_branch) {
    throw new SyncError('The repository identity or visibility changed. Review the destination, then reconnect.');
  }
  try {
    return await commitSubmission({
      request: (path, options) => githubRequest(path, token, options),
      repository: { full_name: repository.fullName, default_branch: repo.default_branch },
      submission,
    });
  } catch (error) {
    if (!(error instanceof GitCommitError)) throw error;
    if (error.response && (error.status === 401 || error.status === 429 ||
        error.response.headers.get('X-RateLimit-Remaining') === '0' ||
        (error.status === 403 && error.response.headers.has('Retry-After')))) {
      await expectJson(error.response, 'GitHub');
    }
    throw new SyncError(error.message, { retry: error.retry || error.status >= 500 });
  }
}
