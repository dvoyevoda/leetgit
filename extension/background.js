import { appRequest, connectApp } from './app.js';
import { workerOrigin } from './config.js';
import { connectToken, expectJson, SyncError, syncToken } from './github.js';
import { normalizeSubmission, submissionTitle } from './solution.js';

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
  await updateBadge(state);
}

async function updateBadge(state) {
  const badge = state.error ? ['!', '#b83e2f'] : state.pending.length ? [String(state.pending.length), '#a05a00'] :
    state.last ? ['✓', '#13804a'] : ['', '#a05a00'];
  await Promise.all([
    chrome.action.setBadgeText({ text: badge[0] }),
    chrome.action.setBadgeBackgroundColor({ color: badge[1] }),
  ]).catch(() => {});
}

function publicState({ connection, pending, last, error, includeProblemText }) {
  return { repository: connection?.repository ?? null, pending: pending.length, last, error, includeProblemText: includeProblemText === true };
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
    state.last = null;
    state.includeProblemText = false;
  }
  state.error = null;
  await saveState(state);
  await ensureAlarm();
  return publicState(state);
}

function notifyTab(tabId, status, details) {
  if (Number.isInteger(tabId)) {
    void chrome.tabs.sendMessage(tabId, { type: 'relay.feedback', status, ...details }, { frameId: 0 }).catch(() => {});
  }
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
    notifyTab(tabId, 'blocked', { message });
    throw new SyncError(message);
  }
  await ensureAlarm();
  submission.includeProblemText = state.includeProblemText === true;
  if (!submission.includeProblemText && submission.problem) delete submission.problem.descriptionMarkdown;
  state.pending.push({ submission, tabId, attempts: 0 });
  await saveState(state);
  notifyTab(tabId, 'queued', { title: submissionTitle(submission) });
  return { queued: true };
}

async function flush(force = false) {
  const state = await readState();
  if (!state.connection || !state.pending.length) return publicState(state);
  if (!force && state.error && (!state.error.nextAt || state.error.nextAt > Date.now())) {
    return publicState(state);
  }
  const connection = state.connection;
  const item = state.pending[0];
  const submission = {
    ...item.submission,
    includeProblemText: state.includeProblemText === true && item.submission.includeProblemText !== false,
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
    state.last = {
      ...result, id: submission.id, slug: submission.slug, title,
      difficulty: submission.problem?.difficulty, language: submission.language,
      acceptedAt: submission.acceptedAt, stats: submission.stats,
    };
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
  if (feedback) notifyTab(item.tabId, feedback.status, feedback);
  if (!state.error && state.pending.length) scheduleFlush();
  return publicState(state);
}

function scheduleFlush() {
  void serial(() => flush()).catch(() => {});
}

async function disconnect() {
  const state = await readState();
  if (state.connection?.mode === 'app' && state.connection.origin === workerOrigin) {
    await appRequest('/session', state.connection.token, 'DELETE').catch(() => {});
  }
  const cleared = { connection: null, pending: [], recent: [], last: null, error: null, includeProblemText: false };
  await saveState(cleared);
  return publicState(cleared);
}

async function setProblemText(enabled) {
  const state = await readState();
  state.includeProblemText = enabled === true;
  if (!state.includeProblemText) {
    for (const { submission } of state.pending) {
      submission.includeProblemText = false;
      if (submission.problem) delete submission.problem.descriptionMarkdown;
    }
  }
  await saveState(state);
  return publicState(state);
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const fromLeetcode = sender.frameId === 0 && sender.origin === 'https://leetcode.com' &&
    sender.url?.startsWith('https://leetcode.com/') && sender.tab;
  const fromPopup = sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('popup.html');
  let operation;
  if (message?.type === 'leetcode.accepted' && fromLeetcode) {
    operation = serial(() => enqueue(message.submission, sender.tab.id)).then(result => {
      if (result.queued) scheduleFlush();
      return result;
    });
  } else if (fromPopup) {
    switch (message?.type) {
      case 'relay.status': operation = readState().then(publicState); break;
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
    if (message.type.startsWith('relay.connect')) operation = operation.then(state => {
      if (state.pending) scheduleFlush();
      return state;
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
  void readState().then(updateBadge).catch(() => {});
}

chrome.runtime.onInstalled.addListener(restoreStatus);
chrome.runtime.onStartup.addListener(restoreStatus);
