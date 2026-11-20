const contextKey = 'problemTabs';
let updates = Promise.resolve();

function schedule(operation) {
  const result = updates.then(operation);
  updates = result.catch(() => {});
  return result;
}

async function tabContexts() {
  return (await chrome.storage.session.get(contextKey))[contextKey] ?? {};
}

function badgeFor(slug, state) {
  if (!slug || !state?.connection) return ['', '#13804a'];
  if (state.error && state.pending[0]?.submission.slug === slug) return ['!', '#b83e2f'];
  const pending = state.pending.filter(item => item.submission.slug === slug).length;
  if (pending) return [String(pending), '#a05a00'];
  const saved = state.last?.slug === slug || state.syncedProblems?.includes(slug);
  return [saved ? '✓' : '', '#13804a'];
}

async function paint(tabId, slug, state) {
  const [text, color] = badgeFor(slug, state);
  await Promise.allSettled([
    chrome.action.setBadgeText({ tabId, text }),
    chrome.action.setBadgeBackgroundColor({ tabId, color }),
  ]);
}

export function updateProblemContext(tabId, slug, readState) {
  return schedule(async () => {
    const contexts = await tabContexts();
    if (!slug && !contexts[tabId]) return;
    if (slug) contexts[tabId] = slug;
    else delete contexts[tabId];
    await chrome.storage.session.set({ [contextKey]: contexts });
    await paint(tabId, slug, slug ? await readState() : null);
  });
}

export function refreshProblemBadges(state) {
  return schedule(async () => {
    const contexts = await tabContexts();
    await Promise.all(Object.entries(contexts).map(([tabId, slug]) => paint(Number(tabId), slug, state)));
  });
}
