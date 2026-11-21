import { Buffer } from 'node:buffer';
import { sign } from 'node:crypto';
import { commitSubmission, GitCommitError } from '../extension/commit.js';

const API = 'https://api.github.com';
const GITHUB = 'https://github.com';
const JSON_TYPE = 'application/vnd.github+json';

export class GitHubError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

function githubHeaders(token, body) {
  const headers = {
    Accept: JSON_TYPE,
    Authorization: `Bearer ${token}`,
    'User-Agent': 'SolveToGit',
    'X-GitHub-Api-Version': '2026-03-10',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return headers;
}

async function githubRequest(path, token, method = 'GET', body) {
  return fetch(API + path, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(7000),
    headers: githubHeaders(token, body),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function githubJSON(path, token, method, body) {
  const response = await githubRequest(path, token, method, body);
  if (!response.ok) {
    if (response.status === 429 || response.headers.get('x-ratelimit-remaining') === '0') {
      throw new GitHubError('GitHub is rate limiting requests. Try again later.', 503);
    }
    throw new GitHubError('GitHub could not verify the repository connection.', response.status);
  }
  return response.json();
}

export function githubAppJWT(env, now = Math.floor(Date.now() / 1000)) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claims = { iat: now - 60, exp: now + 300, iss: env.GITHUB_CLIENT_ID };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const value = `${header}.${payload}`;
  const signature = sign('RSA-SHA256', Buffer.from(value), env.GITHUB_PRIVATE_KEY);
  return `${value}.${signature.toString('base64url')}`;
}

export function oauthURL(env, state, challenge) {
  const url = new URL('/login/oauth/authorize', GITHUB);
  url.search = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: env.APP_ORIGIN + '/auth/callback',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return url;
}

export function installURL(env, state) {
  const url = new URL(`/apps/${env.GITHUB_APP_SLUG}/installations/new`, GITHUB);
  url.searchParams.set('state', state);
  return url;
}

export async function getUserToken(env, code, verifier) {
  const response = await fetch(GITHUB + '/login/oauth/access_token', {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(7000),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      code_verifier: verifier,
      redirect_uri: env.APP_ORIGIN + '/auth/callback',
    }),
  });
  if (!response.ok) throw new GitHubError('GitHub authorization failed. Start setup again.');
  const result = await response.json();
  if (typeof result.access_token !== 'string' || !result.access_token) {
    throw new GitHubError('GitHub authorization failed. Start setup again.');
  }
  return result.access_token;
}

export async function revokeUserToken(env, token) {
  const auth = Buffer.from(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`).toString('base64');
  // The token is discarded even if the revocation request fails.
  await fetch(`${API}/applications/${encodeURIComponent(env.GITHUB_CLIENT_ID)}/token`, {
    method: 'DELETE',
    redirect: 'error',
    signal: AbortSignal.timeout(7000),
    headers: { ...githubHeaders(token, {}), Authorization: `Basic ${auth}` },
    body: JSON.stringify({ access_token: token }),
  }).catch(() => {});
}

function personalInstallation(installation, ownerId) {
  return installation?.account?.id === ownerId && installation.account.type === 'User';
}

function hasExpectedPermissions(permissions) {
  return permissions?.contents === 'write' && permissions.metadata === 'read' &&
    Object.keys(permissions).every((permission) => ['contents', 'metadata'].includes(permission));
}

function validInstallation(installation, ownerId) {
  return personalInstallation(installation, ownerId) &&
    installation.repository_selection === 'selected' && !installation.suspended_at &&
    hasExpectedPermissions(installation.permissions);
}

function soleRepository(result, ownerId) {
  const repo = result.repositories?.[0];
  if (result.total_count !== 1 || result.repositories?.length !== 1 ||
      repo?.owner?.id !== ownerId || repo.archived || repo.disabled ||
      !Number.isSafeInteger(repo.id) || !/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(repo.full_name) ||
      typeof repo.default_branch !== 'string' || !repo.default_branch || typeof repo.private !== 'boolean') {
    return null;
  }
  return repo;
}

export async function userInstallation(token, expectedInstallationId) {
  const user = await githubJSON('/user', token);
  if (!Number.isSafeInteger(user.id)) return null;

  let page = 1;
  let result;
  do {
    result = await githubJSON(`/user/installations?per_page=100&page=${page}`, token);
    const installation = result.installations?.find((candidate) =>
      personalInstallation(candidate, user.id) &&
      (expectedInstallationId == null || candidate.id === expectedInstallationId));
    if (installation) {
      if (!Number.isSafeInteger(installation.id) || !validInstallation(installation, user.id)) {
        return null;
      }
      const repositories = await githubJSON(
        `/user/installations/${installation.id}/repositories?per_page=2`, token,
      );
      const repo = soleRepository(repositories, user.id);
      if (!repo?.permissions?.push) return null;
      return { installationId: installation.id, ownerId: user.id, repo };
    }
    page += 1;
  } while (page <= 10 && (page - 1) * 100 < result.total_count);
  return null;
}

async function getInstallationToken(jwt, installationId, permissions, repositoryId) {
  const request = { permissions };
  if (repositoryId !== undefined) request.repository_ids = [repositoryId];
  const result = await githubJSON(
    `/app/installations/${installationId}/access_tokens`, jwt, 'POST', request,
  );
  if (typeof result.token !== 'string' || !result.token) {
    throw new GitHubError('GitHub did not issue a repository token.');
  }
  return result;
}

function disconnected() {
  return new GitHubError('Reconnect the GitHub App with exactly one selected personal repository.', 403);
}

async function revokeInstallationToken(token) {
  await githubRequest('/installation/token', token, 'DELETE').catch(() => {});
}

export async function checkInstallation(jwt, session) {
  let installation;
  try {
    installation = await githubJSON(`/app/installations/${session.installation_id}`, jwt);
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) throw disconnected();
    throw error;
  }
  if (!validInstallation(installation, session.owner_id)) throw disconnected();

  // A metadata-only token can check the current selection. It cannot read or write file contents.
  const metadata = await getInstallationToken(jwt, session.installation_id, { metadata: 'read' });
  try {
    if (metadata.permissions?.metadata !== 'read' ||
        Object.keys(metadata.permissions).some((permission) => permission !== 'metadata')) {
      throw disconnected();
    }
    const result = await githubJSON('/installation/repositories?per_page=2', metadata.token);
    const repo = soleRepository(result, session.owner_id);
    if (!repo || repo.id !== session.repository_id) throw disconnected();
    if (Number(repo.private) !== session.repository_private) {
      throw new GitHubError('Repository visibility changed. Review the destination and reconnect.', 403);
    }
    return repo;
  } finally {
    await revokeInstallationToken(metadata.token);
  }
}

export function repositoryInfo(repo) {
  return { id: repo.id, fullName: repo.full_name, url: `${GITHUB}/${repo.full_name}`, private: repo.private };
}

export async function syncFile(jwt, session, repo, submission) {
  const repositoryId = session.repository_id;
  const result = await getInstallationToken(
    jwt, session.installation_id, { contents: 'write', metadata: 'read' }, repositoryId,
  );
  try {
    if (!hasExpectedPermissions(result.permissions) || result.repositories?.length !== 1 ||
        result.repositories[0].id !== repositoryId) {
      throw disconnected();
    }
    return await commitSubmission({
      request: (path, { method, body } = {}) => githubRequest(path, result.token, method, body),
      repository: repo,
      submission,
    });
  } catch (error) {
    if (!(error instanceof GitCommitError)) throw error;
    if (error.response && (error.status === 429 || error.response.headers.get('X-RateLimit-Remaining') === '0' ||
        (error.status === 403 && error.response.headers.has('Retry-After')))) {
      throw new GitHubError('GitHub is rate limiting requests. Try again later.', 429);
    }
    throw new GitHubError(error.message, error.status);
  } finally {
    await revokeInstallationToken(result.token);
  }
}
