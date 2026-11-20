import { workerOrigin } from './config.js';
import { encodeRepository, normalizeRepositoryName } from './github.js';

const byId = id => document.getElementById(id);
const setup = byId('setup');
const connected = byId('connected');
const notice = byId('notice');
const repoInput = byId('repo-input');
const tokenInput = byId('token-input');
const retry = byId('retry');
const outcome = { created: 'Saved', updated: 'Updated', unchanged: 'Already up to date' };
let current;
let operating = false;
let reconnecting = false;

function message(text, error = false) {
  notice.toggleAttribute('data-error', error);
  notice.textContent = text;
  notice.hidden = !text;
}

function render(state) {
  current = state;
  const { repository, pending, last, error } = state;
  connected.hidden = !repository;
  setup.hidden = !!repository && !reconnecting;
  retry.hidden = pending < 1;
  message(error?.message ?? (repository ? '' : 'Choose where to save your solutions.'), !!error);
  if (!repository) return;
  const link = byId('repository');
  link.textContent = repository.fullName;
  link.href = `https://github.com/${encodeRepository(repository.fullName)}`;
  byId('visibility').textContent = repository.private ? 'Private' : 'Public';
  byId('sync-status').textContent = pending
    ? `${pending} ${pending === 1 ? 'solution' : 'solutions'} waiting to sync`
    : last ? `${outcome[last.outcome] ?? 'Synced'} · ${last.slug}` : 'Ready for your next Accepted submission.';
  const file = byId('file');
  file.hidden = true;
  if (typeof last?.url === 'string' && last.url.startsWith(`${link.href}/blob/`)) {
    file.href = last.url;
    file.hidden = false;
  }
}

async function command(type, data = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...data });
  if (!result?.ok) throw new Error(result?.error ?? 'Could not reach LeetGit. Try reopening it.');
  return result;
}

async function run(button, operation) {
  if (operating) return;
  operating = true;
  button.disabled = true;
  message('Working…');
  try {
    render(await operation());
  } catch (error) {
    message(error.message, true);
  } finally {
    operating = false;
    button.disabled = false;
  }
}

byId('create-token').addEventListener('click', () => {
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
  void chrome.storage.local.set({ repositoryDraft: name })
    .then(() => chrome.tabs.create({ url: url.href }))
    .catch(() => message('Could not open GitHub’s token form. Try again.', true));
});

byId('token-form').addEventListener('submit', event => {
  event.preventDefault();
  void run(byId('connect-token'), async () => {
    const state = await command('relay.connectToken', { name: repoInput.value, token: tokenInput.value });
    reconnecting = false;
    tokenInput.value = '';
    return state;
  });
});

if (workerOrigin) {
  const app = byId('connect-app');
  app.hidden = false;
  app.addEventListener('click', () => void run(app, async () => {
    const origin = new URL(workerOrigin);
    if (origin.protocol !== 'https:' || origin.origin !== workerOrigin) throw new Error('The configured Worker must be an HTTPS origin.');
    const allowed = await chrome.permissions.request({ origins: [`${origin.origin}/*`] });
    if (!allowed) throw new Error('Chrome needs access to the configured Worker to connect.');
    const state = await command('relay.connectApp');
    reconnecting = false;
    return state;
  }));
}

byId('reconnect').addEventListener('click', () => {
  reconnecting = !reconnecting;
  repoInput.value = current.repository.fullName;
  render(current);
  if (reconnecting) repoInput.focus();
});

byId('disconnect').addEventListener('click', event => {
  if (current?.pending && !confirm('Disconnect and discard the solutions waiting to sync?')) return;
  void run(event.currentTarget, async () => {
    const state = await command('relay.disconnect');
    reconnecting = false;
    return state;
  });
});

retry.addEventListener('click', () => void run(retry, () => command('relay.retry')));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.relay && !operating) {
    void command('relay.status').then(render).catch(() => {});
  }
});

void command('relay.status').then(render).catch(error => message(error.message, true));
void chrome.storage.local.get('repositoryDraft').then(({ repositoryDraft }) => {
  if (repositoryDraft && !repoInput.value) repoInput.value = repositoryDraft;
}).catch(() => {});
