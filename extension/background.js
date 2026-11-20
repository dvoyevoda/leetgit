import { appRequest, connectApp } from './app.js';
import { workerOrigin } from './config.js';
import { connectToken, expectJson, SyncError, syncToken } from './github.js';
import { normalizeSubmission, submissionTitle } from './solution.js';
import { refreshProblemBadges, updateProblemContext } from './problem-badges.js';
import { problemStatus, rememberProblemResult } from './problem-status.js';

// Keep the installed retry alarm when upgrading from v0.1.0.
const alarmName = 'leetrelay-sync';
const maxPending = 20;
const maxRecent = 200;
const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
let action = Promise.resolve();

function serial(operation) {
  const next = action.then(operation);
  action = next.catch(() => {});
  return next;
}

async function readState() {
  await storageReady;
  const { relay } = await chrome.storage.local.get('relay');
  return relay ?? { connection: null, pending: [], recent: [], last: null, error: null };
}

async function saveState(state) {
  await chrome.storage.local.set({ relay: state });
  await refreshProblemBadges(state).catch(() => {});
}

function problemTextEnabled(state) {
  // v0.2.0 stored false on every first connection. Only decisions made under the new default count as overrides.
  return state.problemTextPreference !== false;
}

function validSlug(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,149}$/.test(value);
}

async function popupContext(tabId) {
  try {
    if (!Number.isInteger(tabId)) {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      tabId = tab?.id;
    }
    if (Number.isInteger(tabId)) {
      const context = await chrome.tabs.sendMessage(tabId, { type: 'relay.readContext' }, { frameId: 0 });
      if (validSlug(context?.slug)) return { page: 'problem', slug: context.slug };
      if (context?.slug === null) return { page: 'leetcode', slug: null };
    }
  } catch { /* Tabs without this extension’s LeetCode script have no context. */ }
  return { page: 'other', slug: null };
}

async function publicState(state, tabId) {
  const context = await popupContext(tabId);
  const { connection, pending } = state;
  return {
    ...context,
    ...problemStatus(state, context.slug),
    repository: connection?.repository ?? null,
    totalPending: pending.length,
    includeProblemText: problemTextEnabled(state),
  };
}

async function clearSetupDrafts() {
  await Promise.allSettled([
    chrome.storage.local.remove('repositoryDraft'),
    chrome.storage.session.remove('tokenDraft'),
  ]);
}

async function ensureAlarm() {
  if (!(await chrome.alarms.get(alarmName))) {
    await chrome.alarms.create(alarmName, { periodInMinutes: 1 });
  }
}

async function setConnection(connection) {
  const state = await readState();
  const previous = state.connection;
  const sameRepo = previous?.repository.id === connection.repository.id &&
    previous.repository.private === connection.repository.private;
  if (state.pending.length && !sameRepo) {
    throw new SyncError('Disconnect and clear the pending queue before switching repositories.');
  }
  if (previous?.mode === 'app' && previous.token !== connection.token && previous.origin === workerOrigin) {
    await appRequest('/session', previous.token, 'DELETE').catch(() => {});
  }
  state.connection = connection;
  if (!sameRepo) {
    state.recent = [];
    state.syncedProblems = [];
    state.results = {};
    state.last = null;
    delete state.problemTextPreference;
  }
  state.error = null;
  await saveState(state);
  await clearSetupDrafts();
  await ensureAlarm();
  return state;
}

function notifyTab(tabId, slug, status, details) {
  if (!Number.isInteger(tabId)) return;
  void chrome.tabs.sendMessage(tabId, { type: 'relay.feedback', slug, status, ...details }, { frameId: 0 }).catch(() => {});
}

async function enqueue(input, tabId) {
  const state = await readState();
  if (!state.connection) return { queued: false };
  const submission = normalizeSubmission(input);
  if (state.recent.includes(submission.id) || state.pending.some(item => item.submission.id === submission.id)) {
    return { queued: false };
  }
  if (state.pending.length >= maxPending) {
    const message = 'LeetGit’s queue is full. Retry the pending syncs, then resubmit.';
    notifyTab(tabId, submission.slug, 'blocked', { message });
    throw new SyncError(message);
  }
  await ensureAlarm();
  submission.includeProblemText = problemTextEnabled(state);
  if (!submission.includeProblemText && submission.problem) delete submission.problem.descriptionMarkdown;
  state.pending.push({ submission, tabId, attempts: 0 });
  await saveState(state);
  notifyTab(tabId, submission.slug, 'queued', { title: submissionTitle(submission) });
  return { queued: true };
}

async function flush(force = false) {
  const state = await readState();
  if (!state.connection || !state.pending.length) return state;
  if (!force && state.error && (!state.error.nextAt || state.error.nextAt > Date.now())) {
    return state;
  }
  const connection = state.connection;
  const item = state.pending[0];
  const submission = {
    ...item.submission,
    includeProblemText: problemTextEnabled(state) && item.submission.includeProblemText !== false,
  };
  if (!submission.includeProblemText && submission.problem) delete submission.problem.descriptionMarkdown;
  const title = submissionTitle(submission);
  let feedback;
  try {
    let result;
    if (connection.mode === 'app') {
      if (!workerOrigin || connection.origin !== workerOrigin) {
        throw new SyncError('The GitHub App server changed. Reconnect to continue.');
      }
      result = await expectJson(await appRequest('/sync', connection.token, 'POST', submission), 'GitHub App');
    } else {
      result = await syncToken(connection, submission);
    }
    state.pending.shift();
    state.recent.push(item.submission.id);
    state.recent = state.recent.slice(-maxRecent);
    rememberProblemResult(state, {
      outcome: result.outcome, path: result.path, url: result.url, readmeUrl: result.readmeUrl,
      id: submission.id, slug: submission.slug, title,
      difficulty: submission.problem?.difficulty, language: submission.language,
      acceptedAt: submission.acceptedAt, stats: submission.stats,
    });
    state.error = null;
    feedback = { status: result.outcome, title, url: result.readmeUrl ?? result.url };
  } catch (error) {
    item.attempts += 1;
    const retry = error instanceof SyncError ? error.retry : true;
    const delay = Math.min(2 ** Math.min(item.attempts - 1, 6) * 60000, 30 * 60000);
    state.error = {
      message: error instanceof SyncError ? error.message : 'Sync was interrupted. LeetGit will retry.',
      nextAt: retry ? Date.now() + Math.max(delay, error.retryAfter || 0) : null,
    };
    if (item.attempts === 1 || force) {
      feedback = { status: retry ? 'delayed' : 'blocked', title, message: state.error.message };
    }
  }
  await saveState(state);
  if (feedback) notifyTab(item.tabId, submission.slug, feedback.status, feedback);
  if (!state.error && state.pending.length) scheduleFlush();
  return state;
}

function scheduleFlush() {
  void serial(() => flush()).catch(() => {});
}

async function disconnect() {
  const state = await readState();
  if (state.connection?.mode === 'app' && state.connection.origin === workerOrigin) {
    await appRequest('/session', state.connection.token, 'DELETE').catch(() => {});
  }
  const cleared = { connection: null, pending: [], recent: [], syncedProblems: [], last: null, error: null };
  await saveState(cleared);
  await clearSetupDrafts();
  return cleared;
}

async function setProblemText(enabled) {
  const state = await readState();
  state.problemTextPreference = enabled === true;
  if (!state.problemTextPreference) {
    for (const { submission } of state.pending) {
      submission.includeProblemText = false;
      if (submission.problem) delete submission.problem.descriptionMarkdown;
    }
  }
  await saveState(state);
  return state;
}

function notifyPopupOfContextChange(tabId) {
  void chrome.runtime.sendMessage({ type: 'relay.contextChanged', tabId }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const fromLeetcode = sender.frameId === 0 && sender.origin === 'https://leetcode.com' &&
    sender.url?.startsWith('https://leetcode.com/') && Number.isInteger(sender.tab?.id) &&
    (!sender.documentLifecycle || sender.documentLifecycle === 'active');
  const fromPopup = sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('popup.html');
  let operation;
  if (message?.type === 'leetcode.context' && fromLeetcode) {
    const slug = message.slug;
    if (slug !== null && !validSlug(slug)) return;
    operation = updateProblemContext(sender.tab.id, slug, readState).then(() => notifyPopupOfContextChange(sender.tab.id));
  } else if (message?.type === 'leetcode.accepted' && fromLeetcode) {
    operation = serial(() => enqueue(message.submission, sender.tab.id)).then(result => {
      if (result.queued) scheduleFlush();
      return result;
    });
  } else if (fromPopup) {
    switch (message?.type) {
      case 'relay.status': operation = readState(); break;
      case 'relay.connectToken':
        operation = connectToken(message.name, message.token).then(connection => serial(() => setConnection(connection)));
        break;
      case 'relay.connectApp':
        operation = connectApp().then(connection => serial(() => setConnection(connection)));
        break;
      case 'relay.disconnect': operation = serial(disconnect); break;
      case 'relay.setProblemText': operation = serial(() => setProblemText(message.enabled)); break;
      case 'relay.retry': operation = serial(() => flush(true)); break;
      default: return;
    }
    operation = operation.then(state => {
      if (message.type.startsWith('relay.connect') && state.pending.length) scheduleFlush();
      return publicState(state, message.tabId);
    });
  } else return;

  operation.then(
    result => respond({ ok: true, ...result }),
    error => respond({ ok: false, error: error instanceof SyncError ? error.message : 'LeetGit could not complete that action.' }),
  );
  return true;
});

chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === alarmName) scheduleFlush(); });
function restoreStatus() {
  void ensureAlarm().catch(() => {});
  void chrome.action.setBadgeText({ text: '' }).catch(() => {});
  void readState().then(refreshProblemBadges).catch(() => {});
}

chrome.runtime.onInstalled.addListener(restoreStatus);
chrome.runtime.onStartup.addListener(restoreStatus);

function forgetTab(tabId) {
  void updateProblemContext(tabId, null, readState).catch(() => {});
}

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading') {
    forgetTab(tabId);
    notifyPopupOfContextChange(tabId);
  }
  // Chrome also reports loading/complete for same-document result navigation.
  if (change.status === 'complete') {
    void chrome.tabs.sendMessage(tabId, { type: 'relay.refreshContext' }, { frameId: 0 }).catch(() => {});
    notifyPopupOfContextChange(tabId);
  }
});
chrome.tabs.onActivated.addListener(({ tabId }) => notifyPopupOfContextChange(tabId));
chrome.tabs.onRemoved.addListener(forgetTab);
chrome.tabs.onReplaced.addListener((_added, removed) => forgetTab(removed));
