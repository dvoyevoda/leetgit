import { createHash, randomBytes } from 'node:crypto';
import { MAX_CODE_BYTES, normalizeSubmission, solutionFile } from '../extension/solution.js';
import {
  checkInstallation,
  getUserToken,
  githubAppJWT,
  GitHubError,
  installURL,
  oauthURL,
  repositoryInfo,
  revokeUserToken,
  syncFile,
  userInstallation,
} from './github.js';

const FLOW_TTL = 15 * 60;
const SESSION_TTL = 90 * 24 * 60 * 60;
// JSON may escape a source byte as a six-character Unicode sequence.
const MAX_BODY_BYTES = 6 * MAX_CODE_BYTES + 2048;
const RANDOM_TOKEN = /^[a-zA-Z0-9_-]{43}$/;
const CLIENT_STATE = /^[a-zA-Z0-9_-]{16,128}$/;
const EXTENSION_ID = /^[a-p]{32}$/;
const JSON_TYPE = 'application/json; charset=utf-8';
const SELECT_REPO = 'Install the GitHub App on your personal account and select exactly one repository.';
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

function randomToken() {
  return randomBytes(32).toString('base64url');
}

function hash(value) {
  return createHash('sha256').update(value).digest('base64url');
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function chromeIds(env) {
  return (env.EXTENSION_IDS || '').split(',').map((id) => id.trim()).filter((id) => EXTENSION_ID.test(id));
}

function configIsValid(env) {
  try {
    const origin = new URL(env.APP_ORIGIN);
    return origin.protocol === 'https:' && origin.origin === env.APP_ORIGIN &&
      /^[a-z0-9-]+$/.test(env.GITHUB_APP_SLUG) &&
      /^[a-zA-Z0-9._]+$/.test(env.GITHUB_CLIENT_ID) &&
      !!env.GITHUB_CLIENT_SECRET && !!env.GITHUB_PRIVATE_KEY && !!env.DB &&
      chromeIds(env).length > 0;
  } catch {
    return false;
  }
}

function response(body, status, headers = {}) {
  return new Response(body, { status, headers: { ...SECURITY_HEADERS, ...headers } });
}

function json(body, status = 200) {
  return response(JSON.stringify(body), status, { 'Content-Type': JSON_TYPE });
}

function page(title, description, status, link = '', headers = {}) {
  // All text is authored here. The only interpolated link is constructed from a validated GitHub App slug.
  return response(
    `<!doctype html><html lang="en"><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title} · LeetGit</title><main><h1>${title}</h1>
    <p>${description}</p>${link}</main></html>`,
    status,
    { 'Content-Type': 'text/html; charset=utf-8', ...headers },
  );
}

function withCors(result, origin) {
  if (origin === null) return result;
  const headers = new Headers(result.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  headers.set('Vary', 'Origin');
  return new Response(result.body, { status: result.status, headers });
}

function flowCookieName(state) {
  return `__Host-leetgit-${state.slice(0, 16)}`;
}

function flowCookie(state, value, maxAge = FLOW_TTL) {
  return `${flowCookieName(state)}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
}

function redirect(destination, cookie) {
  const headers = { Location: destination.toString() };
  if (cookie) headers['Set-Cookie'] = cookie;
  return response(null, 303, headers);
}

function allowedRedirect(env, redirectUri) {
  return chromeIds(env).some((id) => redirectUri === `https://${id}.chromiumapp.org/github`);
}

async function startFlow(env, flow, stage, installationId = null) {
  const state = randomToken();
  const secret = randomToken();
  const verifier = stage === 'oauth' ? randomToken() : null;
  await env.DB.prepare(
    `INSERT INTO auth_flows
     (state_hash, browser_hash, redirect_uri, client_state, stage, verifier, installation_id, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    hash(state), hash(secret), flow.redirect_uri, flow.client_state, stage, verifier,
    installationId, nowSeconds() + FLOW_TTL,
  ).run();
  const cookie = flowCookie(state, secret);
  if (stage === 'oauth') return redirect(oauthURL(env, state, hash(verifier)), cookie);

  const installation = installURL(env, state);
  return page(
    'Choose your solution repository',
    'On GitHub, select your personal account, choose Only select repositories, and select one repository.',
    200,
    `<p><a href="${installation}">Continue to GitHub</a></p>`,
    { 'Set-Cookie': cookie },
  );
}

async function receiveFlow(request, env, url, stage) {
  const state = url.searchParams.get('state');
  if (!state || !RANDOM_TOKEN.test(state)) return null;
  const prefix = flowCookieName(state) + '=';
  const entry = (request.headers.get('Cookie') || '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  const secret = entry?.slice(prefix.length);
  if (!secret || !RANDOM_TOKEN.test(secret)) return null;

  // Claim the state atomically so two callbacks cannot both create a session.
  const flow = await env.DB.prepare(
    `DELETE FROM auth_flows
     WHERE state_hash = ? AND browser_hash = ? AND stage = ? AND expires_at > ?
     RETURNING redirect_uri, client_state, verifier, installation_id`,
  ).bind(hash(state), hash(secret), stage, nowSeconds()).first();
  if (!flow || !allowedRedirect(env, flow.redirect_uri)) return null;
  return { ...flow, state };
}

function finishFlow(flow, result) {
  const url = new URL(flow.redirect_uri);
  url.hash = new URLSearchParams({ state: flow.client_state, ...result }).toString();
  return redirect(url, flowCookie(flow.state, '', 0));
}

function missingFlow() {
  return page('Setup expired', 'Open LeetGit and start GitHub setup again.', 400);
}

async function handleSetup(request, env, url) {
  if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
  if (url.pathname === '/auth/start') {
    const redirectUri = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state');
    if (!allowedRedirect(env, redirectUri) || !state || !CLIENT_STATE.test(state)) {
      return page('Invalid setup link', 'Open LeetGit and start GitHub setup again.', 400);
    }
    return startFlow(env, { redirect_uri: redirectUri, client_state: state }, 'oauth');
  }

  if (url.pathname === '/auth/install') {
    const flow = await receiveFlow(request, env, url, 'install');
    if (!flow) return missingFlow();
    const id = url.searchParams.get('installation_id');
    const installationId = Number(id);
    if (!id || !/^\d+$/.test(id) || !Number.isSafeInteger(installationId) || installationId < 1) {
      return finishFlow(flow, { error: SELECT_REPO });
    }
    return startFlow(env, flow, 'oauth', installationId);
  }

  if (url.pathname !== '/auth/callback') return json({ error: 'Not found.' }, 404);
  const flow = await receiveFlow(request, env, url, 'oauth');
  if (!flow) return missingFlow();
  const code = url.searchParams.get('code');
  if (!code || code.length > 512) return finishFlow(flow, { error: 'GitHub authorization was canceled.' });

  try {
    const token = await getUserToken(env, code, flow.verifier);
    let match;
    try {
      match = await userInstallation(token, flow.installation_id);
    } finally {
      await revokeUserToken(env, token);
    }
    if (!match && flow.installation_id !== null) return finishFlow(flow, { error: SELECT_REPO });
    if (!match) return startFlow(env, flow, 'install');

    const session = randomToken();
    await env.DB.prepare(
      `INSERT INTO sessions
       (token_hash, installation_id, owner_id, repository_id, repository_private, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      hash(session), match.installationId, match.ownerId, match.repo.id, Number(match.repo.private),
      nowSeconds() + SESSION_TTL,
    ).run();
    return finishFlow(flow, { token: session, repo: match.repo.full_name });
  } catch (error) {
    const message = error instanceof GitHubError ? error.message : 'GitHub setup failed. Start setup again.';
    return finishFlow(flow, { error: message });
  }
}

async function sessionFor(request, env) {
  const match = /^Bearer ([a-zA-Z0-9_-]{43})$/.exec(request.headers.get('Authorization') || '');
  if (!match) return null;
  const tokenHash = hash(match[1]);
  return env.DB.prepare(
    `SELECT token_hash, installation_id, owner_id, repository_id, repository_private
     FROM sessions WHERE token_hash = ? AND expires_at > ?`,
  ).bind(tokenHash, nowSeconds()).first();
}

async function readSubmission(request) {
  const contentType = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json' || !request.body) {
    throw new GitHubError('Send a JSON submission.', 415);
  }
  if (Number(request.headers.get('Content-Length')) > MAX_BODY_BYTES) {
    throw new GitHubError('The submission is too large.', 413);
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new GitHubError('The submission is too large.', 413);
      text += decoder.decode(chunk.value, { stream: true });
    }
    const submission = normalizeSubmission(JSON.parse(text + decoder.decode()));
    if (!submission) throw new Error('Invalid submission');
    return submission;
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof GitHubError) throw error;
    throw new GitHubError('The submission is invalid.', 400);
  } finally {
    reader.releaseLock();
  }
}

async function handleApi(request, env, url) {
  const isSession = url.pathname === '/session';
  if (!isSession && url.pathname !== '/sync') return json({ error: 'Not found.' }, 404);
  const origin = request.headers.get('Origin');
  const allowed = origin !== null && chromeIds(env).some((id) => origin === `chrome-extension://${id}`);
  if (origin !== null && !allowed) return json({ error: 'Origin not allowed.' }, 403);
  if (request.method === 'OPTIONS') return withCors(response(null, 204), origin);

  const methodAllowed = isSession ? ['GET', 'DELETE'].includes(request.method) : request.method === 'POST';
  let result;
  if (!methodAllowed) {
    result = json({ error: 'Method not allowed.' }, 405);
  } else {
    try {
      const session = await sessionFor(request, env);
      if (!session) return withCors(json({ error: 'Reconnect LeetGit to GitHub.' }, 401), origin);
      if (isSession && request.method === 'DELETE') {
        await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(session.token_hash).run();
        return withCors(response(null, 204), origin);
      }

      const file = isSession ? null : solutionFile(await readSubmission(request));
      const jwt = githubAppJWT(env);
      const repo = await checkInstallation(jwt, session);
      result = isSession ?
        json({ repository: repositoryInfo(repo) }) :
        json(await syncFile(jwt, session, repo, file));
    } catch (error) {
      if (error instanceof GitHubError) {
        result = json({ error: error.message }, error.status);
      } else {
        result = json({ error: 'The sync service could not complete the request. Try again.' }, 502);
      }
    }
  }
  return withCors(result, origin);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!configIsValid(env) || url.origin !== env.APP_ORIGIN) {
      return json({ error: 'LeetGit setup is incomplete.' }, 503);
    }
    if (url.pathname === '/' && request.method === 'GET') return json({ service: 'LeetGit' });
    try {
      if (url.pathname.startsWith('/auth/')) return await handleSetup(request, env, url);
      return await handleApi(request, env, url);
    } catch {
      return json({ error: 'The sync service is unavailable. Try again.' }, 503);
    }
  },
  async scheduled(_event, env) {
    const now = nowSeconds();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM auth_flows WHERE expires_at <= ?').bind(now),
      env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
    ]);
  },
};
