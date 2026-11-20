import assert from 'node:assert/strict';
import test from 'node:test';
import { connectToken, syncToken } from '../extension/github.js';
import { normalizeRepositoryName } from '../extension/repository.js';

const token = 'github_pat_' + 'a'.repeat(24);
const repo = { id: 42, full_name: 'owner/solutions', private: true, default_branch: 'main' };
const submission = {
  id: '101', slug: 'two-sum', language: 'python3', code: '# café 🧩\nreturn a + b\n',
  acceptedAt: '2026-11-20T18:00:00.000Z',
  problem: { frontendId: '1', paidOnly: false, descriptionMarkdown: 'A complete fixture description.' },
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
  let storage = { repositoryDraft: 'https://github.com/owner/solutions' };
  const session = { tokenDraft: 'temporary fixture' };
  let access;
  const feedback = [];
  const badges = new Map();
  const pages = new Map([[1, 'two-sum'], [2, 'add-two-numbers'], [3, null]]);
  const runtime = {
    id: 'test-id', getURL: path => `chrome-extension://test-id/${path}`,
    onMessage: runtimeEvent(), onInstalled: runtimeEvent(), onStartup: runtimeEvent(),
    async sendMessage() {},
  };
  const chrome = {
    runtime,
    storage: {
      local: {
        async setAccessLevel(value) { access = value.accessLevel; },
        async get() { return structuredClone(storage); },
        async set(value) { storage = { ...storage, ...structuredClone(value) }; },
        async remove(key) { delete storage[key]; },
      },
      session: {
        async get() { return structuredClone(session); },
        async set(value) { Object.assign(session, structuredClone(value)); },
        async remove(key) { delete session[key]; },
      },
    },
    action: { async setBadgeText(value) { badges.set(value.tabId, value.text); }, async setBadgeBackgroundColor() {} },
    tabs: {
      onUpdated: runtimeEvent(), onRemoved: runtimeEvent(), onReplaced: runtimeEvent(), onActivated: runtimeEvent(),
      async query() { return [{ id: 1 }]; },
      async sendMessage(tabId, data) {
        if (data.type === 'relay.readContext') {
          if (!pages.has(tabId)) throw new Error('No LeetCode content script');
          return { slug: pages.get(tabId) };
        }
        if (data.type === 'relay.feedback') feedback.push({ tabId, ...data });
      },
    },
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
  const connected = await send(connect, popup);
  assert.equal(connected.repository.id, 42);
  assert.equal(connected.includeProblemText, true);
  assert.equal(storage.repositoryDraft, undefined);
  assert.equal(session.tokenDraft, undefined);
  assert.equal(access, 'TRUSTED_CONTEXTS');
  assert.equal(await send({ type: 'leetcode.accepted', submission }, popup), undefined);
  assert.equal(await send({ type: 'leetcode.accepted', submission }, { ...leetcode, frameId: 1 }), undefined);
  await send({ type: 'leetcode.context', slug: 'two-sum' }, leetcode);
  await send({ type: 'leetcode.context', slug: 'add-two-numbers' }, { ...leetcode, tab: { id: 2 } });

  offline = true;
  assert.deepEqual(await send({ type: 'leetcode.accepted', submission }, leetcode), { ok: true, queued: true });
  for (let poll = 0; !storage.relay.error && poll < 20; poll += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(storage.relay.pending[0].submission.code, submission.code);
  assert.equal(storage.relay.pending[0].submission.includeProblemText, true);
  assert.equal(storage.relay.pending[0].submission.problem.descriptionMarkdown, 'A complete fixture description.');
  assert.ok(storage.relay.error.nextAt > Date.now());
  assert.deepEqual(feedback.map(item => item.status), ['queued', 'delayed']);
  const otherPending = await send({ type: 'relay.status', tabId: 2 }, popup);
  assert.equal(otherPending.pending, 0);
  assert.equal(otherPending.totalPending, 1);
  assert.equal(otherPending.error, null);

  offline = false;
  await import('../extension/background.js?restarted');
  const state = await send({ type: 'relay.retry' }, popup);
  assert.equal(state.pending, 0);
  assert.equal(state.last.outcome, 'created');
  assert.equal(state.last.readmeUrl, 'https://github.com/owner/solutions/blob/main/solutions/1-two-sum/README.md');
  assert.equal(feedback.at(-1).tabId, 1);
  assert.equal(feedback.at(-1).status, 'created');
  assert.equal(badges.get(1), '✓');
  assert.equal(badges.get(2), '');
  assert.equal(JSON.stringify(state).includes(token), false);
  assert.equal(state.page, 'problem');
  assert.equal(state.saved, true);
  for (const [tabId, expected] of [[2, 'problem'], [3, 'leetcode'], [4, 'other']]) {
    const unseen = await send({ type: 'relay.status', tabId }, popup);
    assert.equal(unseen.page, expected);
    assert.equal(unseen.last, null);
    assert.equal(unseen.saved, false);
  }
  assert.deepEqual(await send({ type: 'leetcode.accepted', submission }, leetcode), { ok: true, queued: false });
  assert.equal(commits, 1);
  await send({ type: 'leetcode.context', slug: 'add-two-numbers' }, leetcode);
  assert.equal(badges.get(1), '');
  await send({ type: 'leetcode.context', slug: 'two-sum' }, leetcode);
  assert.equal(badges.get(1), '✓');
  chrome.tabs.onUpdated.listener(1, { status: 'loading' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(badges.get(1), '');
  assert.equal((await send({ type: 'relay.setProblemText', enabled: false }, popup)).includeProblemText, false);
  assert.equal((await send(connect, popup)).includeProblemText, false);
});
