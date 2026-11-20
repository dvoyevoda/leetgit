import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const script = await readFile(new URL('../extension/problem-context.js', import.meta.url), 'utf8');

function page(pathname, { prerendering = false, topFrame = true } = {}) {
  const messages = [];
  const listeners = [];
  const window = Object.assign(new EventTarget(), { location: { pathname }, navigation: new EventTarget() });
  window.top = topFrame ? window : {};
  const document = Object.assign(new EventTarget(), { prerendering });
  runInNewContext(script, {
    window, document,
    chrome: { runtime: {
      id: 'leetgit-fixture',
      async sendMessage(message) { messages.push(structuredClone(message)); },
      onMessage: { addListener(listener) { listeners.push(listener); } },
    } },
  });
  return { window, document, messages, receive(message, senderId) {
    for (const listener of listeners) listener(message, { id: senderId });
  } };
}

test('the top-level LeetCode page reports SPA problem transitions and restores a returning problem', () => {
  const { window, messages } = page('/problems/two-sum/description/');
  function navigate(pathname) {
    window.location.pathname = pathname;
    window.navigation.dispatchEvent(new Event('currententrychange'));
  }

  navigate('/problems/two-sum/submissions/981/');
  navigate('/problems/add-two-numbers/');
  navigate('/problemset/');
  window.location.pathname = '/problems/two-sum';
  window.dispatchEvent(new Event('popstate'));
  window.navigation.dispatchEvent(new Event('currententrychange'));
  assert.deepEqual(messages, [
    { type: 'leetcode.context', slug: 'two-sum' },
    { type: 'leetcode.context', slug: 'two-sum' },
    { type: 'leetcode.context', slug: 'add-two-numbers' },
    { type: 'leetcode.context', slug: null },
    { type: 'leetcode.context', slug: 'two-sum' },
  ]);
});

test('pageshow restores the context even if the pathname did not change', () => {
  const { window, messages } = page('/problems/two-sum/submissions/981/');
  window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
  window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
  assert.deepEqual(messages.map(message => message.slug), ['two-sum', 'two-sum', 'two-sum']);
});

test('the trusted extension can refresh unchanged context once the tab finishes loading', () => {
  const { receive, messages } = page('/problems/two-sum/submissions/981/');
  receive({ type: 'relay.refreshContext' }, 'another-extension');
  receive({ type: 'something-else' }, 'leetgit-fixture');
  assert.equal(messages.length, 1);
  receive({ type: 'relay.refreshContext' }, 'leetgit-fixture');
  assert.deepEqual(messages.map(message => message.slug), ['two-sum', 'two-sum']);
});

test('the script skips child frames and waits until a prerendered page is activated', () => {
  assert.deepEqual(page('/problems/two-sum/', { topFrame: false }).messages, []);

  const { document, messages } = page('/problems/two-sum/', { prerendering: true });
  assert.deepEqual(messages, []);
  document.prerendering = false;
  document.dispatchEvent(new Event('prerenderingchange'));
  assert.deepEqual(messages, [{ type: 'leetcode.context', slug: 'two-sum' }]);
});

test('outside practice routes, malformed slugs and contest paths report no problem', () => {
  for (const pathname of ['/problems/', '/problems/%2e%2e/', '/problems/Two-Sum/', '/contest/example/problems/two-sum/']) {
    assert.deepEqual(page(pathname).messages, [{ type: 'leetcode.context', slug: null }]);
  }
});
