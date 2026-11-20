import { appRequest, connectApp } from './app.js';
import { workerOrigin } from './config.js';
import { connectToken, expectJson, SyncError, syncToken } from './github.js';
import { normalizeSubmission } from './solution.js';

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
  await chrome.action.setBadgeText({ text: state.error ? '!' : state.pending.length ? String(state.pending.length) : '' });
}

function publicState({ connection, pending, last, error }) {
  return { repository: connection?.repository ?? null, pending: pending.length, last, error };
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
  }
  state.error = null;
  await saveState(state);
  await ensureAlarm();
  return publicState(state);
}

async function enqueue(input) {
  const state = await readState();
  if (!state.connection) return { queued: false };
  const submission = normalizeSubmission(input);
  if (state.recent.includes(submission.id) || state.pending.some(item => item.submission.id === submission.id)) {
    return { queued: false };
  }
  if (state.pending.length >= maxPending) {
    throw new SyncError('LeetGit’s queue is full. Retry your pending syncs, then resubmit this solution.');
  }
  await ensureAlarm();
  state.pending.push({ submission, attempts: 0 });
  await saveState(state);
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
  try {
    let result;
    if (connection.mode === 'app') {
      if (!workerOrigin || connection.origin !== workerOrigin) {
        throw new SyncError('The GitHub App server changed. Reconnect to continue.');
      }
      result = await expectJson(await appRequest('/sync', connection.token, 'POST', item.submission), 'GitHub App');
    } else {
      result = await syncToken(connection, item.submission);
    }
    state.pending.shift();
    state.recent.push(item.submission.id);
    state.recent = state.recent.slice(-maxRecent);
    state.last = { ...result, id: item.submission.id, slug: item.submission.slug };
    state.error = null;
  } catch (error) {
    item.attempts += 1;
    const retry = error instanceof SyncError ? error.retry : true;
    const delay = Math.min(2 ** Math.min(item.attempts - 1, 6) * 60000, 30 * 60000);
    state.error = {
      message: error instanceof SyncError ? error.message : 'Sync was interrupted. LeetGit will retry.',
      nextAt: retry ? Date.now() + Math.max(delay, error.retryAfter || 0) : null,
    };
  }
  await saveState(state);
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
  const cleared = { connection: null, pending: [], recent: [], last: null, error: null };
  await saveState(cleared);
  return publicState(cleared);
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const fromLeetcode = sender.frameId === 0 && sender.origin === 'https://leetcode.com' &&
    sender.url?.startsWith('https://leetcode.com/') && sender.tab;
  const fromPopup = sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('popup.html');
  let operation;
  if (message?.type === 'leetcode.accepted' && fromLeetcode) {
    operation = serial(() => enqueue(message.submission)).then(result => {
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
chrome.runtime.onInstalled.addListener(() => { void ensureAlarm(); });
chrome.runtime.onStartup.addListener(() => { void ensureAlarm(); });
