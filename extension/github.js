import { solutionFile } from './solution.js';

const api = 'https://api.github.com';

export class SyncError extends Error {
  constructor(message, { retry = false, retryAfter = 0 } = {}) {
    super(message);
    this.retry = retry;
    this.retryAfter = retryAfter;
  }
}

export function normalizeRepositoryName(value) {
  const name = String(value ?? '').trim();
  if (!/^[a-z\d](?:[a-z\d-]{0,38})\/[a-z\d_.-]{1,100}$/i.test(name) ||
      ['.', '..'].includes(name.split('/')[1])) {
    throw new SyncError('Enter the repository as owner/name.');
  }
  return name;
}

export function encodeRepository(name) {
  return normalizeRepositoryName(name).split('/').map(encodeURIComponent).join('/');
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
    throw new SyncError(`${service} rate limit reached. LeetGit will retry.`, {
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

function githubRequest(path, token, write) {
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (write) headers['Content-Type'] = 'application/json';
  return request(`${api}${path}`, {
    headers,
    method: write ? 'PUT' : 'GET',
    body: write && JSON.stringify(write),
  });
}

export async function connectToken(name, input) {
  const token = String(input ?? '').trim();
  if (!/^github_pat_[a-zA-Z0-9_]{20,250}$/.test(token)) {
    throw new SyncError('Paste a fine-grained GitHub token beginning with github_pat_.');
  }
  const response = await githubRequest(`/repos/${encodeRepository(name)}`, token);
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

function encodeBase64(bytes) {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 8192) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  }
  return btoa(binary);
}

export async function syncToken(connection, submission) {
  const file = solutionFile(submission);
  const { repository, token } = connection;
  const repoPath = `/repos/${encodeRepository(repository.fullName)}`;
  const repo = await expectJson(await githubRequest(repoPath, token), 'GitHub');
  if (repo.id !== repository.id || repo.private !== repository.private || repo.archived || repo.disabled ||
      typeof repo.default_branch !== 'string' || !repo.default_branch) {
    throw new SyncError('The repository identity or visibility changed. Review the destination, then reconnect.');
  }
  const path = `${repoPath}/contents/${file.path}`;
  const content = encodeBase64(new TextEncoder().encode(file.content));
  const url = `https://github.com/${encodeRepository(repository.fullName)}/blob/${encodeURIComponent(repo.default_branch)}/${file.path}`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await githubRequest(`${path}?ref=${encodeURIComponent(repo.default_branch)}`, token);
    const current = response.status === 404 ? null : await expectJson(response, 'GitHub');
    if (current && (current.type !== 'file' || typeof current.sha !== 'string')) {
      throw new SyncError('The destination path is occupied by something other than a file.');
    }
    if (current?.content?.replace(/\s/g, '') === content) {
      return { outcome: 'unchanged', path: file.path, url };
    }
    const update = { message: file.message, content, branch: repo.default_branch };
    if (current) update.sha = current.sha;
    const result = await githubRequest(path, token, update);
    if (result.status === 409 && attempt === 0) continue;
    await expectJson(result, 'GitHub');
    return { outcome: current ? 'updated' : 'created', path: file.path, url };
  }
}
