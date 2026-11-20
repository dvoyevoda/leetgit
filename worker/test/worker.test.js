import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import test from 'node:test';
import worker from '../index.js';
import { checkInstallation, githubAppJWT, repositoryInfo, syncFile } from '../github.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const id = 'abcdefghijklmnopabcdefghijklmnop';
const redirect = `https://${id}.chromiumapp.org/github`;
const origin = 'https://leetgit.example';
const env = {
  APP_ORIGIN: origin,
  EXTENSION_IDS: id,
  GITHUB_APP_SLUG: 'leetgit-test',
  GITHUB_CLIENT_ID: 'Iv1.test',
  GITHUB_CLIENT_SECRET: 'example-test-secret',
  GITHUB_PRIVATE_KEY: privateKey.export({ format: 'pem', type: 'pkcs1' }),
};
const permissions = { contents: 'write', metadata: 'read' };
const installation = {
  id: 5, account: { id: 8, type: 'User' }, repository_selection: 'selected', permissions,
};
const repository = {
  id: 13, owner: { id: 8 }, full_name: 'test/solutions', default_branch: 'main',
  private: true, permissions: { push: true },
};
const session = {
  installation_id: 5, owner_id: 8, repository_id: 13, repository_private: 1,
};

function sha256(value) {
  return createHash('sha256').update(value).digest('base64url');
}

function apiResponse(data, status = 200) {
  return data ? Response.json(data, { status }) : new Response(null, { status });
}

function setupDatabase() {
  let flow;
  let sessionData;
  return {
    get sessionData() { return sessionData; },
    prepare(sql) {
      const query = sql.trim();
      return {
        bind(...params) {
          if (query.startsWith('INSERT INTO auth_flows')) {
            return { async run() { flow = params; } };
          }
          if (query.startsWith('DELETE FROM auth_flows')) {
            return {
              async first() {
                if (!flow) return null;
                const [state, browser, callback, client, stage, verifier, installationId, expires] = flow;
                if (state !== params[0] || browser !== params[1] || stage !== params[2] || expires <= params[3]) {
                  return null;
                }
                flow = null;
                return { redirect_uri: callback, client_state: client, verifier, installation_id: installationId };
              },
            };
          }
          if (query.startsWith('INSERT INTO sessions')) {
            return { async run() { sessionData = params; } };
          }
          throw new Error(`Unexpected query: ${query}`);
        },
      };
    },
  };
}

test('GitHub App JWT has bounded lifetime and is signed by the app private key', () => {
  const [header, payload, signature] = githubAppJWT(env, 500).split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), { iat: 440, exp: 800, iss: 'Iv1.test' });
  assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey,
    Buffer.from(signature, 'base64url')), true);
});

test('OAuth binds the approved callback, browser, and PKCE and consumes the flow once', async (t) => {
  const DB = setupDatabase();
  const config = { ...env, DB };
  const start = new URL('/auth/start', origin);
  start.searchParams.set('state', 'chrome-oauth-state-example');
  start.searchParams.set('redirect_uri', 'https://evil.example/github');
  const rejected = await worker.fetch(new Request(start), config);
  assert.equal(rejected.status, 400);
  start.searchParams.set('redirect_uri', redirect);
  const begun = await worker.fetch(new Request(start), config);
  assert.equal(begun.status, 303);
  const cookie = begun.headers.get('Set-Cookie');
  assert.match(cookie, /HttpOnly; SameSite=Lax/);
  const authorization = new URL(begun.headers.get('Location'));
  assert.equal(authorization.hostname, 'github.com');
  assert.equal(authorization.searchParams.has('scope'), false);
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  const providerState = authorization.searchParams.get('state');
  const callback = new URL('/auth/callback', origin);
  callback.search = new URLSearchParams({ state: providerState, code: 'example-code' });
  const makeCallback = () => new Request(callback, { headers: { Cookie: cookie.split(';')[0] } });

  const requests = t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === 'https://github.com/login/oauth/access_token') {
      assert.equal(options.body.get('code'), 'example-code');
      assert.equal(sha256(options.body.get('code_verifier')), authorization.searchParams.get('code_challenge'));
      return apiResponse({ access_token: 'github-user-token' });
    }
    if (url.endsWith('/user')) return apiResponse({ id: 8 });
    if (url.includes('/user/installations?')) return apiResponse({ total_count: 1, installations: [installation] });
    if (url.includes('/user/installations/5/repositories?')) {
      return apiResponse({ total_count: 1, repositories: [repository] });
    }
    if (url.endsWith('/applications/Iv1.test/token') && options.method === 'DELETE') {
      return apiResponse(null, 204);
    }
    assert.fail(`Unexpected request: ${url}`);
  });

  const noCookie = await worker.fetch(new Request(callback), config);
  assert.equal(noCookie.status, 400);
  assert.equal(requests.mock.callCount(), 0);
  const connected = await worker.fetch(makeCallback(), config);
  assert.equal(connected.status, 303);
  const location = new URL(connected.headers.get('Location'));
  const result = new URLSearchParams(location.hash.slice(1));
  assert.equal(result.get('repo'), 'test/solutions');
  assert.equal(result.get('state'), 'chrome-oauth-state-example');
  assert.notEqual(result.get('token'), 'github-user-token');
  assert.deepEqual(DB.sessionData.slice(0, 5), [sha256(result.get('token')), 5, 8, 13, 1]);

  const replay = await worker.fetch(makeCallback(), config);
  assert.equal(replay.status, 400);
  assert.equal(requests.mock.callCount(), 5);
});

test('first-time installation needs the browser state and cannot trust a supplied installation ID', async (t) => {
  const DB = setupDatabase();
  const config = { ...env, DB };
  let OAuthCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/login/oauth/access_token')) {
      OAuthCalls += 1;
      return apiResponse({ access_token: 'github-user-token' });
    }
    if (url.endsWith('/user')) return apiResponse({ id: 8 });
    if (url.includes('/user/installations?')) {
      return apiResponse({ total_count: 1, installations: [{ ...installation, account: { id: 15, type: 'User' } }] });
    }
    if (url.endsWith('/applications/Iv1.test/token') && options.method === 'DELETE') {
      return apiResponse(null, 204);
    }
    assert.fail(`Unexpected request: ${url}`);
  });
  const start = new URL('/auth/start', origin);
  start.search = new URLSearchParams({ state: 'chrome-oauth-state-example', redirect_uri: redirect });

  function nextRequest(previous, path, extras = {}) {
    const link = previous.headers.get('Location');
    const state = new URL(link).searchParams.get('state');
    const cookie = previous.headers.get('Set-Cookie').split(';')[0];
    const url = new URL(path, origin);
    url.search = new URLSearchParams({ state, ...extras });
    return new Request(url, { headers: { Cookie: cookie } });
  }

  const beginning = await worker.fetch(new Request(start), config);
  const installPage = await worker.fetch(nextRequest(beginning, '/auth/callback', { code: 'first' }), config);
  assert.equal(installPage.status, 200);
  const html = await installPage.text();
  assert.match(html, /Only select repositories/);
  const installUrl = new URL(/href="([^"]+)"/.exec(html)[1]);
  assert.equal(installUrl.hostname, 'github.com');
  const returned = new URL('/auth/install', origin);
  returned.search = new URLSearchParams({ state: installUrl.searchParams.get('state'), installation_id: 5 });
  const noCookie = await worker.fetch(new Request(returned), config);
  assert.equal(noCookie.status, 400);
  const cookie = installPage.headers.get('Set-Cookie').split(';')[0];
  const confirmation = await worker.fetch(new Request(returned, { headers: { Cookie: cookie } }), config);
  assert.equal(confirmation.status, 303);
  const rejected = await worker.fetch(nextRequest(confirmation, '/auth/callback', { code: 'second' }), config);
  const result = new URLSearchParams(new URL(rejected.headers.get('Location')).hash.slice(1));
  assert.equal(result.has('token'), false);
  assert.match(result.get('error'), /personal account/);
  assert.equal(DB.sessionData, undefined);
  assert.equal(OAuthCalls, 2);
});

test('Worker rejects an all-repositories grant before minting an installation token', async (t) => {
  const requests = t.mock.method(globalThis, 'fetch', async () =>
    apiResponse({ ...installation, repository_selection: 'all' }));
  await assert.rejects(checkInstallation('app-jwt', session), { status: 403 });
  assert.equal(requests.mock.callCount(), 1);
});

test('Worker uses metadata only to check the pinned repository and rejects a visibility change', async (t) => {
  let privacy = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/app/installations/5')) return apiResponse(installation);
    if (url.endsWith('/app/installations/5/access_tokens')) {
      assert.deepEqual(JSON.parse(options.body), { permissions: { metadata: 'read' } });
      return apiResponse({ token: 'metadata-token', permissions: { metadata: 'read' } });
    }
    assert.equal(options.headers.Authorization, 'Bearer metadata-token');
    if (url.endsWith('/installation/token') && options.method === 'DELETE') {
      return apiResponse(null, 204);
    }
    return apiResponse({ total_count: 1, repositories: [{ ...repository, private: privacy }] });
  });
  await assert.rejects(checkInstallation('app-jwt', session), /visibility changed/);
  privacy = true;
  const found = await checkInstallation('app-jwt', session);
  assert.deepEqual(repositoryInfo(found), {
    id: 13, fullName: 'test/solutions', url: 'https://github.com/test/solutions', private: true,
  });
  await assert.rejects(checkInstallation('app-jwt', { ...session, repository_id: 21 }), { status: 403 });
});

test('Worker scopes the atomic solution and README writes to the repository ID', async (t) => {
  const sourcePath = 'solutions/two-sum/python3.py';
  const readmePath = 'solutions/two-sum/README.md';
  const submission = {
    id: '120', slug: 'two-sum', language: 'python3', code: '# λ\nprint(1)\n',
    acceptedAt: '2026-11-20T12:00:00.000Z',
  };
  const head = 'a'.repeat(40);
  const root = 'b'.repeat(40);
  const newTree = 'c'.repeat(40);
  const newHead = 'd'.repeat(40);
  const sourceBlob = 'e'.repeat(40);
  const readmeBlob = 'f'.repeat(40);
  const fileContents = [];
  let refUpdates = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/app/installations/5/access_tokens')) {
      assert.deepEqual(JSON.parse(options.body), { repository_ids: [13], permissions });
      return apiResponse({ token: 'one-repo-token', permissions, repositories: [repository] });
    }
    assert.equal(options.headers.Authorization, 'Bearer one-repo-token');
    if (options.method === 'DELETE') {
      assert.equal(new URL(url).pathname, '/installation/token');
      return apiResponse(null, 204);
    }
    const path = new URL(url).pathname;
    const prefix = '/repos/test/solutions/git';
    assert.ok(path.startsWith(prefix));
    const resource = path.slice(prefix.length);
    if (resource === '/ref/heads/main') {
      return apiResponse({ ref: 'refs/heads/main', object: { type: 'commit', sha: head } });
    }
    if (resource === `/commits/${head}`) return apiResponse({ tree: { sha: root } });
    if (resource === `/trees/${root}`) return apiResponse({ tree: [], truncated: false });
    if (resource === '/blobs') {
      const { content, encoding } = JSON.parse(options.body);
      assert.equal(encoding, 'base64');
      fileContents.push(Buffer.from(content, 'base64').toString());
      return apiResponse({ sha: fileContents.length === 1 ? sourceBlob : readmeBlob }, 201);
    }
    if (resource === '/trees') {
      assert.deepEqual(JSON.parse(options.body), {
        base_tree: root,
        tree: [
          { path: sourcePath, type: 'blob', mode: '100644', sha: sourceBlob },
          { path: readmePath, type: 'blob', mode: '100644', sha: readmeBlob },
        ],
      });
      return apiResponse({ sha: newTree }, 201);
    }
    if (resource === '/commits') {
      const { tree, parents, message } = JSON.parse(options.body);
      assert.deepEqual({ tree, parents }, { tree: newTree, parents: [head] });
      assert.match(message, /Solve Two Sum \(Python 3\)/);
      return apiResponse({ sha: newHead }, 201);
    }
    assert.equal(resource, '/refs/heads/main');
    assert.equal(options.method, 'PATCH');
    assert.deepEqual(JSON.parse(options.body), { sha: newHead, force: false });
    refUpdates += 1;
    return apiResponse({ object: { sha: newHead } });
  });
  assert.deepEqual(await syncFile('app-jwt', session, repository, submission), {
    outcome: 'created', path: sourcePath,
    url: 'https://github.com/test/solutions/blob/main/' + sourcePath,
    readmeUrl: 'https://github.com/test/solutions/blob/main/' + readmePath,
  });
  assert.equal(fileContents[0], submission.code);
  assert.match(fileContents[1], /python3\.py/);
  assert.equal(refUpdates, 1);
});
