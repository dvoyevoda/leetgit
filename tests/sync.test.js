import assert from 'node:assert/strict';
import test from 'node:test';
import { connectToken, syncToken } from '../extension/github.js';

const token = 'github_pat_' + 'a'.repeat(24);
const repo = { id: 42, full_name: 'owner/solutions', private: true, default_branch: 'main' };
const submission = {
  id: '101', slug: 'two-sum', language: 'python3', code: '# café 🧩\nreturn a + b\n',
  acceptedAt: '2026-11-20T18:00:00.000Z',
};
const base = 'https://api.github.com/repos/owner/solutions';
const filePath = '/contents/solutions/two-sum/python3.py';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

function fakeGithub(harness) {
  const writes = [];
  let value = null;
  harness.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(options.redirect, 'error');
    assert.ok(url === base || url.startsWith(base + filePath));
    if (url === base) return json(repo);
    if (options.method === 'GET') return value ? json(value) : json({}, 404);
    const next = JSON.parse(options.body);
    writes.push(next);
    assert.equal(next.branch, 'main');
    if (value) assert.equal(next.sha, value.sha);
    value = { type: 'file', sha: `sha-${writes.length}`, content: next.content };
    return json({ content: value }, 201);
  });
  return writes;
}

test('direct sync commits exact UTF-8 bytes, updates changed code and skips duplicates', async t => {
  const writes = fakeGithub(t);
  await assert.rejects(connectToken('owner/solutions', 'ghp_example'), /fine-grained/);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
  const connection = await connectToken('owner/solutions', token);
  assert.equal(connection.repository.id, 42);
  assert.equal((await syncToken(connection, submission)).outcome, 'created');
  assert.equal((await syncToken(connection, { ...submission, id: '102' })).outcome, 'unchanged');
  assert.equal((await syncToken(connection, { ...submission, id: '103', code: 'return b + a\n' })).outcome, 'updated');
  assert.equal(writes.length, 2);
  assert.equal(Buffer.from(writes[0].content, 'base64').toString('utf8'), submission.code);
  assert.match(writes[0].message, /\/problems\/two-sum\/submissions\/101\//);
});

test('direct sync refuses a renamed, replaced, or newly public repository before accessing contents', async t => {
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
    action: { async setBadgeText() {} },
    alarms: { onAlarm: runtimeEvent(), async get() {}, async create() {} },
  };
  globalThis.chrome = chrome;
  t.after(() => { delete globalThis.chrome; });
  let offline = false;
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (offline) throw new TypeError('offline');
    if (url === base) return json(repo);
    if (options.method === 'GET') return json({}, 404);
    assert.equal(url, base + filePath);
    return json({}, 201);
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

  const callsBefore = fetch.mock.callCount();
  offline = false;
  await import('../extension/background.js?restarted');
  const state = await send({ type: 'relay.retry' }, popup);
  assert.equal(state.pending, 0);
  assert.equal(state.last.outcome, 'created');
  assert.equal(JSON.stringify(state).includes(token), false);
  assert.deepEqual(await send({ type: 'leetcode.accepted', submission }, leetcode), { ok: true, queued: false });
  assert.equal(fetch.mock.callCount() - callsBefore, 3);
});
