const invalidRepository = 'Enter a GitHub repository URL or owner/repository.';

export function normalizeRepositoryName(value) {
  let name = String(value ?? '').trim();
  if (/^(?:www\.)?github\.com\//i.test(name)) name = `https://${name}`;
  if (/^https?:\/\//i.test(name)) {
    try {
      const url = new URL(name);
      if (!['github.com', 'www.github.com'].includes(url.host) || url.username || url.password) {
        throw new Error(invalidRepository);
      }
      const [, owner, repository] = url.pathname.split('/');
      name = `${decodeURIComponent(owner ?? '')}/${decodeURIComponent(repository ?? '').replace(/\.git$/i, '')}`;
    } catch {
      throw new Error(invalidRepository);
    }
  } else {
    name = name.replace(/\/$/, '');
  }
  if (!/^[a-z\d](?:[a-z\d-]{0,38})\/[a-z\d_.-]{1,100}$/i.test(name) ||
      ['.', '..'].includes(name.split('/')[1])) {
    throw new Error(invalidRepository);
  }
  return name;
}

export function encodeRepository(name) {
  return normalizeRepositoryName(name).split('/').map(encodeURIComponent).join('/');
}

export function githubTokenForm(value, noExpiration = false) {
  const name = normalizeRepositoryName(value);
  const [owner, repository] = name.split('/');
  const url = new URL('https://github.com/settings/personal-access-tokens/new');
  url.search = new URLSearchParams({
    name: 'SolveToGit - LeetCode to Github Sync',
    description: `Sync LeetCode solutions to ${name}. Choose Only select repositories and select only ${repository}.`,
    target_name: owner,
    expires_in: noExpiration ? 'none' : '365',
    contents: 'write',
  });
  return url.href;
}
