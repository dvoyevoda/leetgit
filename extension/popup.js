import { workerOrigin } from './config.js';
import { encodeRepository, normalizeRepositoryName } from './repository.js';
import { submissionLanguage, submissionTitle } from './solution.js';

const byId = id => document.getElementById(id);
const setup = byId('setup');
const connected = byId('connected');
const notice = byId('notice');
const repoInput = byId('repo-input');
const tokenInput = byId('token-input');
const createToken = byId('create-token');
const retry = byId('retry');
const reconnect = byId('reconnect');
const settings = byId('settings');
const includeProblemText = byId('include-problem-text');
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

function clearSetupFields() {
  repositoryDraft.clearField();
  tokenDraft.clearField();
}

function setFormBusy(busy) {
  repoInput.readOnly = busy;
  tokenInput.readOnly = busy;
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

function renderActivity({ pending, last, error }, repositoryUrl) {
  let state = 'ready';
  let icon = '·';
  let title = 'Ready to sync';
  let description = 'Submit a solution on LeetCode to get started.';

  if (error) {
    state = 'error';
    icon = '!';
    title = 'Sync needs attention';
    description = error.message;
    const retryAt = Number(error.nextAt ?? error.retryAt);
    if (retryAt > Date.now()) description += ` Retry scheduled for ${shortTime.format(retryAt)}.`;
  } else if (pending > 0) {
    state = 'pending';
    icon = '↻';
    title = pending === 1 ? 'Solution queued' : `${pending} solutions queued`;
    description = 'Waiting to sync to GitHub.';
  } else if (last) {
    state = 'saved';
    icon = '✓';
    title = statusLabels.get(last.outcome) ?? 'Solution synced';
    description = problemTitle(last);
  }

  byId('activity').dataset.state = state;
  byId('status-icon').textContent = icon;
  byId('sync-status').textContent = title;
  byId('sync-description').textContent = description;
  renderMetadata(state === 'saved' ? last : null);

  const file = byId('file');
  byId('file-label').textContent = state === 'saved' ? 'View code' : 'View last saved code';
  const hasFile = showLink(file, last?.url, repositoryUrl);
  const hasReadme = showLink(byId('readme'), last?.readmeUrl, repositoryUrl);
  byId('activity-links').hidden = !(hasFile || hasReadme);
  retry.hidden = pending < 1;
}

function render(state) {
  current = state;
  const { repository } = state;
  connected.hidden = !repository;
  setup.hidden = !!repository && !reconnecting;
  reconnect.textContent = reconnecting ? 'Cancel reconnect' : 'Reconnect';
  byId('setup-title').textContent = reconnecting ? 'Reconnect repository' : 'Connect a repository';
  byId('setup-purpose').hidden = reconnecting;
  includeProblemText.checked = state.includeProblemText !== false;
  message('');
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
  const result = await chrome.runtime.sendMessage({ type, ...data });
  if (!result?.ok) throw new Error(result?.error ?? 'Could not reach LeetGit. Try reopening it.');
  return result;
}

async function refresh() {
  const request = ++revision;
  const state = await command('relay.status');
  if (request === revision && !operating) render(state);
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
    includeProblemText.checked = current?.includeProblemText !== false;
    message(error.message, true);
  } finally {
    operating = false;
    button.disabled = false;
    setFormBusy(false);
    if (complete) void refresh().catch(() => {});
  }
}

createToken.addEventListener('click', async () => {
  if (operating) return;
  let name;
  try {
    name = normalizeRepositoryName(repoInput.value);
  } catch (error) {
    message(error.message, true);
    repoInput.focus();
    return;
  }
  const url = new URL('https://github.com/settings/personal-access-tokens/new');
  url.search = new URLSearchParams({ name: 'LeetGit', target_name: name.split('/')[0], expires_in: '90', contents: 'write' });
  operating = true;
  setFormBusy(true);
  try {
    await Promise.allSettled(pendingDraftWrites);
    await repositoryDraft.save();
    await chrome.tabs.create({ url: url.href });
  } catch {
    message('Could not save the repository draft or open GitHub’s token form. Try again.', true);
  } finally {
    operating = false;
    setFormBusy(false);
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
  render(current);
  if (reconnecting) repoInput.focus();
});

byId('disconnect').addEventListener('click', event => {
  if (current?.pending && !confirm('Disconnect and discard the solutions waiting to sync?')) return;
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

retry.addEventListener('click', () => void run(retry, () => command('relay.retry'), 'Retrying sync…'));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.relay && !operating) void refresh().catch(() => {});
});

void refresh().then(() => {
  if (!current?.repository) void Promise.allSettled([repositoryDraft.restore(), tokenDraft.restore()]);
}).catch(error => message(error.message, true));
