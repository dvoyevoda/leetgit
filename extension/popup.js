import { workerOrigin } from './config.js';
import { encodeRepository, githubTokenForm, normalizeRepositoryName } from './repository.js';
import { submissionLanguage, submissionTitle } from './solution.js';

const byId = id => document.getElementById(id);
const setup = byId('setup');
const connected = byId('connected');
const notice = byId('notice');
const repoInput = byId('repo-input');
const tokenInput = byId('token-input');
const createToken = byId('create-token');
const noExpiration = byId('token-no-expiration');
const retry = byId('retry');
const queueRetry = byId('queue-retry');
const reconnect = byId('reconnect');
const settings = byId('settings');
const includeProblemText = byId('include-problem-text');
const saveAtRoot = byId('save-at-root');
const statusLabels = new Map([
  ['created', 'Solution saved'],
  ['updated', 'Solution updated'],
  ['unchanged', 'Already up to date'],
]);
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const shortTime = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });
const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
let current;
let operating = false;
let reconnecting = false;
let revision = 0;
const pendingDraftWrites = new Set();

function bindDraft(input, storage, key) {
  let edited = false;

  function save() {
    edited = true;
    const write = storage.set({ [key]: input.value });
    pendingDraftWrites.add(write);
    void write.catch(() => {}).then(() => pendingDraftWrites.delete(write));
    return write;
  }

  input.addEventListener('input', save);
  return {
    save,
    async restore() {
      const { [key]: value } = await storage.get(key);
      if (!edited && !current?.repository && typeof value === 'string') input.value = value;
    },
    clearField() {
      edited = true;
      input.value = '';
    },
  };
}

const repositoryDraft = bindDraft(repoInput, chrome.storage.local, 'repositoryDraft');
const tokenDraft = bindDraft(tokenInput, chrome.storage.session, 'tokenDraft');

function updateTokenDestination() {
  let name = 'your repository';
  try { name = normalizeRepositoryName(repoInput.value); } catch { /* Wait for a complete repository name. */ }
  byId('token-destination').textContent = name;
}

repoInput.addEventListener('input', updateTokenDestination);

function clearSetupFields() {
  repositoryDraft.clearField();
  tokenDraft.clearField();
  noExpiration.checked = false;
  updateTokenDestination();
}

function setFormBusy(busy) {
  repoInput.readOnly = busy;
  tokenInput.readOnly = busy;
  noExpiration.disabled = busy;
  createToken.disabled = busy;
}

function message(text, error = false) {
  notice.toggleAttribute('data-error', error);
  notice.textContent = text;
  notice.hidden = !text;
}

function showText(element, value) {
  element.textContent = value ?? '';
  element.hidden = !value;
  return !element.hidden;
}

function problemTitle(last) {
  if (last.title?.trim()) return last.title.trim();
  return last.slug ? submissionTitle(last) : '';
}

function showTime(dateValue) {
  const time = byId('accepted-at');
  const date = new Date(dateValue);
  const today = new Date();
  if (!dateValue || !Number.isFinite(date.getTime())) return showText(time, '');
  time.dateTime = date.toISOString();
  time.title = date.toLocaleString();
  return showText(time, date.toDateString() === today.toDateString() ? shortTime.format(date) : shortDate.format(date));
}

function metricValue(value, unit) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return `${number.format(value)} ${unit}`;
  }
  if (typeof value === 'string' && value.trim()) {
    return /^\d+(?:\.\d+)?$/.test(value.trim()) ? `${number.format(Number(value))} ${unit}` : value.trim();
  }
  return '';
}

function showMetric(name, value, unit, percentile) {
  const formatted = metricValue(value, unit);
  const percent = percentile == null || percentile === '' ? NaN : Number(percentile);
  const stat = byId(`${name}-stat`);
  stat.hidden = !formatted;
  byId(`${name}-value`).textContent = formatted;
  showText(byId(`${name}-percentile`),
    Number.isFinite(percent) && percent >= 0 && percent <= 100 ? `Beats ${number.format(percent)}%` : '');
  return !stat.hidden;
}

function renderMetadata(last) {
  const difficulty = byId('difficulty');
  const difficultyName = String(last?.difficulty ?? '').toLowerCase();
  const knownDifficulty = ['easy', 'medium', 'hard'].includes(difficultyName);
  difficulty.dataset.level = knownDifficulty ? difficultyName : '';
  const hasDifficulty = showText(difficulty, knownDifficulty
    ? difficultyName.charAt(0).toUpperCase() + difficultyName.slice(1)
    : '');
  const hasLanguage = showText(byId('language'), submissionLanguage(last?.language));
  const hasTime = showTime(last?.acceptedAt);
  byId('submission-meta').hidden = !(hasDifficulty || hasLanguage || hasTime);

  const stats = last?.stats;
  const hasRuntime = showMetric('runtime', stats?.runtime, 'ms', stats?.runtimePercentile);
  const hasMemory = showMetric('memory', stats?.memory, 'MB', stats?.memoryPercentile);
  byId('metrics').hidden = !(hasRuntime || hasMemory);
}

function showLink(link, url, repositoryUrl) {
  link.hidden = typeof url !== 'string' || !url.startsWith(`${repositoryUrl}/blob/`);
  if (link.hidden) link.removeAttribute('href');
  else link.href = url;
  return !link.hidden;
}

function renderActivity({ page, slug, saved, pending, last, error }, repositoryUrl) {
  const onProblem = page === 'problem' && !!slug;
  const result = onProblem && last?.slug === slug ? last : null;
  let state = onProblem ? 'ready' : 'idle';
  let symbol = '';
  let title = onProblem ? 'Ready to sync' : 'Open a LeetCode problem';
  let description = onProblem ? `${problemTitle({ slug })} · Syncs when accepted.` : 'Accepted solutions sync to GitHub.';

  if (page === 'leetcode') {
    title = 'LeetCode page detected';
    description = 'Open a problem to start syncing.';
  } else if (onProblem && error) {
    state = 'error';
    symbol = '!';
    title = 'Sync needs attention';
    description = error.message;
    const retryAt = Number(error.nextAt ?? error.retryAt);
    if (retryAt > Date.now()) description += ` Retry scheduled for ${shortTime.format(retryAt)}.`;
  } else if (onProblem && pending > 0) {
    state = 'pending';
    title = pending === 1 ? 'Solution queued' : `${pending} solutions queued`;
    description = 'Waiting to sync to GitHub.';
  } else if (onProblem && (result || saved)) {
    state = 'saved';
    symbol = '✓';
    title = statusLabels.get(result?.outcome) ?? 'Solution saved';
    description = problemTitle(result ?? { slug });
  }

  byId('activity').dataset.state = state;
  showText(byId('status-symbol'), symbol);
  byId('sync-icon').toggleAttribute('hidden', !!symbol);
  byId('sync-status').textContent = title;
  byId('sync-description').textContent = description;
  byId('page-detected').hidden = !onProblem;
  renderMetadata(state === 'saved' ? result : null);

  const file = byId('file');
  byId('file-label').textContent = state === 'saved' ? 'View code' : 'View last saved code';
  const hasFile = showLink(file, result?.url, repositoryUrl);
  const hasReadme = showLink(byId('readme'), result?.readmeUrl, repositoryUrl);
  byId('activity-links').hidden = !(hasFile || hasReadme);
  retry.hidden = !onProblem || pending < 1;
}

function renderSettings(state) {
  includeProblemText.checked = state?.includeProblemText !== false;
  saveAtRoot.checked = state?.saveAtRoot === true;
}

function render(state, preserveNotice = false) {
  current = state;
  const { repository } = state;
  connected.hidden = !repository;
  setup.hidden = !!repository && !reconnecting;
  reconnect.textContent = reconnecting ? 'Cancel reconnect' : 'Reconnect';
  byId('setup-title').textContent = reconnecting ? 'Reconnect repository' : 'Connect a repository';
  byId('setup-purpose').hidden = reconnecting;
  renderSettings(state);
  queueRetry.hidden = !!state.pending || !(state.totalPending > 0);
  if (!preserveNotice) message('');
  if (!repository) return;

  const link = byId('repository');
  link.textContent = repository.fullName;
  link.title = repository.fullName;
  link.href = `https://github.com/${encodeRepository(repository.fullName)}`;
  const visibility = byId('visibility');
  visibility.textContent = repository.private ? 'Private' : 'Public';
  visibility.dataset.visibility = repository.private ? 'private' : 'public';
  renderActivity(state, link.href);
}

async function command(type, data = {}) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const result = await chrome.runtime.sendMessage({ type, ...data, tabId: tab?.id });
  if (!result?.ok) throw new Error(result?.error ?? 'Could not reach SolveToGit. Try reopening it.');
  return result;
}

async function refresh(preserveNotice = false) {
  const request = ++revision;
  const state = await command('relay.status');
  if (request === revision && !operating) render(state, preserveNotice);
}

async function run(button, operation, progress = 'Working…') {
  if (operating) return;
  operating = true;
  revision += 1;
  button.disabled = true;
  setFormBusy(true);
  if (progress) message(progress);
  let complete = false;
  try {
    render(await operation());
    complete = true;
  } catch (error) {
    renderSettings(current);
    message(error.message, true);
  } finally {
    operating = false;
    button.disabled = false;
    setFormBusy(false);
    void refresh(!complete).catch(() => {});
  }
}

createToken.addEventListener('click', async () => {
  if (operating) return;
  let url;
  try {
    url = githubTokenForm(repoInput.value, noExpiration.checked);
  } catch (error) {
    message(error.message, true);
    repoInput.focus();
    return;
  }
  operating = true;
  setFormBusy(true);
  try {
    await Promise.allSettled(pendingDraftWrites);
    await repositoryDraft.save();
    await chrome.tabs.create({ url });
  } catch {
    message('Could not save the repository draft or open GitHub’s token form. Try again.', true);
  } finally {
    operating = false;
    setFormBusy(false);
    void refresh(true).catch(() => {});
  }
});

byId('token-form').addEventListener('submit', event => {
  event.preventDefault();
  void run(byId('connect-token'), async () => {
    const name = normalizeRepositoryName(repoInput.value);
    await Promise.allSettled(pendingDraftWrites);
    const state = await command('relay.connectToken', { name, token: tokenInput.value });
    reconnecting = false;
    clearSetupFields();
    settings.open = false;
    return state;
  }, 'Checking your repository…');
});

if (workerOrigin) {
  const app = byId('connect-app');
  app.hidden = false;
  byId('setup-divider').hidden = false;
  app.addEventListener('click', () => void run(app, async () => {
    const origin = new URL(workerOrigin);
    if (origin.protocol !== 'https:' || origin.origin !== workerOrigin) throw new Error('The configured Worker must be an HTTPS origin.');
    const allowed = await chrome.permissions.request({ origins: [`${origin.origin}/*`] });
    if (!allowed) throw new Error('Chrome needs access to the configured Worker to connect.');
    await Promise.allSettled(pendingDraftWrites);
    const state = await command('relay.connectApp');
    reconnecting = false;
    clearSetupFields();
    settings.open = false;
    return state;
  }, 'Opening GitHub…'));
}

reconnect.addEventListener('click', () => {
  if (operating || !current?.repository) return;
  reconnecting = !reconnecting;
  clearSetupFields();
  repoInput.value = current.repository.fullName;
  updateTokenDestination();
  render(current);
  if (reconnecting) repoInput.focus();
});

byId('disconnect').addEventListener('click', event => {
  if (operating) return;
  if ((current?.totalPending ?? current?.pending) && !confirm('Disconnect and discard the solutions waiting to sync?')) return;
  void run(event.currentTarget, async () => {
    await Promise.allSettled(pendingDraftWrites);
    const state = await command('relay.disconnect');
    reconnecting = false;
    clearSetupFields();
    settings.open = false;
    return state;
  }, 'Disconnecting…');
});

includeProblemText.addEventListener('change', () => {
  if (operating) {
    includeProblemText.checked = current?.includeProblemText !== false;
    return;
  }
  const enabled = includeProblemText.checked;
  void run(includeProblemText, () => command('relay.setProblemText', { enabled }), '');
});

saveAtRoot.addEventListener('change', () => {
  if (operating) {
    saveAtRoot.checked = current?.saveAtRoot === true;
    return;
  }
  const enabled = saveAtRoot.checked;
  void run(saveAtRoot, () => command('relay.setSaveAtRoot', { enabled }), '');
});

for (const button of [retry, queueRetry]) {
  button.addEventListener('click', () => void run(button, () => command('relay.retry'), 'Retrying sync…'));
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.relay && !operating) void refresh().catch(() => {});
});

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === 'relay.contextChanged' && !operating) void refresh(true).catch(() => {});
});

void refresh().then(() => {
  if (!current?.repository) void Promise.allSettled([repositoryDraft.restore(), tokenDraft.restore()]).then(updateTokenDestination);
}).catch(error => message(error.message, true));
