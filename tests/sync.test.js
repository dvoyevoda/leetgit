import assert from 'node:assert/strict';
import test from 'node:test';
import { connectToken, syncToken } from '../extension/github.js';
import { normalizeRepositoryName } from '../extension/repository.js';

const token = 'github_pat_' + 'a'.repeat(24);
const repo = { id: 42, full_name: 'owner/solutions', private: true, default_branch: 'main' };
const submission = {
  id: '101', slug: 'two-sum', language: 'python3', code: '# café 🧩\nreturn a + b\n',
  acceptedAt: '2026-11-20T18:00:00.000Z',
};
const base = 'https://api.github.com/repos/owner/solutions';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('direct setup accepts a full GitHub repository URL and sends only a fine-grained token', async t => {
  const reply = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, base);
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(options.redirect, 'error');
    return json(repo);
  });
  await assert.rejects(connectToken('owner/solutions', 'ghp_example'), /fine-grained/);
  await assert.rejects(connectToken('https://github.com.example/owner/solutions', token), /GitHub repository URL/);
  await assert.rejects(connectToken('https://user@example.com/owner/solutions', token), /GitHub repository URL/);
  assert.equal(reply.mock.callCount(), 0);
  const connection = await connectToken(' https://github.com/owner/solutions.git?ref=example ', token);
  assert.equal(connection.repository.id, 42);
  assert.equal(normalizeRepositoryName('github.com/owner/solutions/tree/main'), 'owner/solutions');
  assert.equal(normalizeRepositoryName('owner/solutions/'), 'owner/solutions');
});

test('direct sync refuses a renamed, replaced, or newly public repository before accessing Git data', async t => {
  const reply = t.mock.method(globalThis, 'fetch', async () => json(repo));
  const connection = await connectToken('owner/solutions', token);
  for (const changed of [new Response(null, { status: 301 }), json({ ...repo, id: 43 }), json({ ...repo, private: false })]) {
    reply.mock.mockImplementationOnce(async () => changed);
    await assert.rejects(syncToken(connection, submission));
  }
  assert.deepEqual(reply.mock.calls.map(call => call.arguments[0]), Array(4).fill(base));
});

function runtimeEvent() {
  return { addListener(listener) { this.listener = listener; } };
}

test('the background restores pending code after restart and restricts which senders can sync', async t => {
  let storage = {};
  let access;
  const feedback = [];
  const badges = [];
  const runtime = {
    id: 'test-id', getURL: path => `chrome-extension://test-id/${path}`,
    onMessage: runtimeEvent(), onInstalled: runtimeEvent(), onStartup: runtimeEvent(),
  };
  const chrome = {
    runtime,
    storage: { local: {
      async setAccessLevel(value) { access = value.accessLevel; },
      async get() { return structuredClone(storage); },
      async set(value) { storage = structuredClone(value); },
    } },
    action: { async setBadgeText(value) { badges.push(value.text); }, async setBadgeBackgroundColor() {} },
    tabs: { async sendMessage(tabId, data) { feedback.push({ tabId, ...data }); } },
    alarms: { onAlarm: runtimeEvent(), async get() {}, async create() {} },
  };
  globalThis.chrome = chrome;
  t.after(() => { delete globalThis.chrome; });
  let offline = false;
  let blob = 0;
  const commit = 'a'.repeat(40);
  const tree = 'b'.repeat(40);
  let commits = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (offline) throw new TypeError('offline');
    if (url === base) return json(repo);
    const path = url.slice(`${base}/git`.length);
    if (path === '/ref/heads/main') return json({ ref: 'refs/heads/main', object: { type: 'commit', sha: commit } });
    if (path === `/commits/${commit}`) return json({ tree: { sha: tree } });
    if (path === `/trees/${tree}`) return json({ tree: [], truncated: false });
    if (path === '/blobs') return json({ sha: String(++blob).repeat(40) });
    if (path === '/trees') return json({ sha: tree });
    if (path === '/commits') return json({ sha: commit });
    assert.equal(path, '/refs/heads/main');
    assert.equal(options.method, 'PATCH');
    commits += 1;
    return json({});
  });
  await import('../extension/background.js?initial');
  const popup = { id: runtime.id, url: runtime.getURL('popup.html') };
  const leetcode = { origin: 'https://leetcode.com', url: 'https://leetcode.com/problems/two-sum/', frameId: 0, tab: { id: 1 } };
  const send = (message, sender) => new Promise(resolve => {
    if (!runtime.onMessage.listener(message, sender, resolve)) resolve(undefined);
  });
  const connect = { type: 'relay.connectToken', name: 'owner/solutions', token };
  assert.equal(await send(connect, leetcode), undefined);
  assert.equal((await send(connect, popup)).repository.id, 42);
  assert.equal(access, 'TRUSTED_CONTEXTS');
  assert.equal(await send({ type: 'leetcode.accepted', submission }, popup), undefined);
  assert.equal(await send({ type: 'leetcode.accepted', submission }, { ...leetcode, frameId: 1 }), undefined);

  offline = true;
  assert.deepEqual(await send({ type: 'leetcode.accepted', submission }, leetcode), { ok: true, queued: true });
  for (let poll = 0; !storage.relay.error && poll < 20; poll += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(storage.relay.pending[0].submission.code, submission.code);
  assert.ok(storage.relay.error.nextAt > Date.now());
  assert.deepEqual(feedback.map(item => item.status), ['queued', 'delayed']);

  offline = false;
  await import('../extension/background.js?restarted');
  const state = await send({ type: 'relay.retry' }, popup);
  assert.equal(state.pending, 0);
  assert.equal(state.last.outcome, 'created');
  assert.equal(state.last.readmeUrl, 'https://github.com/owner/solutions/blob/main/solutions/two-sum/README.md');
  assert.equal(feedback.at(-1).tabId, 1);
  assert.equal(feedback.at(-1).status, 'created');
  assert.equal(badges.at(-1), '✓');
  assert.equal(JSON.stringify(state).includes(token), false);
  assert.deepEqual(await send({ type: 'leetcode.accepted', submission }, leetcode), { ok: true, queued: false });
  assert.equal(commits, 1);
});
