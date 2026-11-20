import { problemReadme, solutionFile } from './solution.js';

const MAX_README_BYTES = 2 * 1024 * 1024;
const MAX_COMMIT_ATTEMPTS = 3;
const encoder = new TextEncoder();

export class GitCommitError extends Error {
  constructor(message, { response, status = response?.status ?? 502, retry = false } = {}) {
    super(message);
    this.response = response;
    this.status = status;
    this.retry = retry;
  }
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function encodeBase64(bytes) {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 8192) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  }
  return btoa(binary);
}

async function gitBlobSha(bytes) {
  const header = encoder.encode(`blob ${bytes.length}\0`);
  const object = new Uint8Array(header.length + bytes.length);
  object.set(header);
  object.set(bytes, header.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', object));
  return Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('');
}

function objectSha(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new GitCommitError('GitHub returned an invalid Git object ID.');
  }
  return value;
}

function requireOK(response, message) {
  if (!response.ok) throw new GitCommitError(message, { response });
  return response;
}

async function readHead(api, ref, branch) {
  const response = await api(`/ref/${ref}`);
  const message = [404, 409].includes(response.status)
    ? 'The default branch is unavailable. Initialize the repository with a commit before syncing.'
    : 'GitHub could not read the default branch.';
  const result = await requireOK(response, message).json();
  if (result.object?.type !== 'commit' || result.ref !== `refs/heads/${branch}`) {
    throw new GitCommitError('GitHub returned an unexpected default branch.');
  }
  return objectSha(result.object.sha);
}

async function solutionFolder(api, root, folders) {
  let sha = root;
  for (const name of [...folders, null]) {
    const response = await api(`/trees/${sha}`);
    const data = await requireOK(response, 'GitHub could not inspect the solution folder.').json();
    if (!Array.isArray(data.tree) || data.truncated) {
      throw new GitCommitError('GitHub returned an incomplete repository tree.');
    }
    if (name === null) return data.tree;
    const entry = data.tree.find((item) => item.path === name);
    if (!entry) return [];
    if (entry.type !== 'tree' || entry.mode !== '040000') {
      throw new GitCommitError('A solution folder is occupied by a file or another Git object.', { status: 409 });
    }
    sha = objectSha(entry.sha);
  }
}

function fileEntry(tree, name, label) {
  const entry = tree.find((item) => item.path === name);
  if (entry && (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode))) {
    throw new GitCommitError(`The ${label} path is occupied by something other than a regular file.`, { status: 409 });
  }
  return entry;
}

async function readReadme(api, entry) {
  if (!entry) return null;
  if (entry.size > MAX_README_BYTES) {
    throw new GitCommitError('The existing problem README exceeds 2 MiB.', { status: 413 });
  }
  const response = await api(`/blobs/${objectSha(entry.sha)}`);
  const blob = await requireOK(response, 'GitHub could not read the existing problem README.').json();
  try {
    if (blob.encoding !== 'base64' || blob.size > MAX_README_BYTES ||
        typeof blob.content !== 'string' || blob.content.length > MAX_README_BYTES * 2) {
      throw new Error('Unexpected blob encoding or size');
    }
    const binary = atob(blob.content);
    if (binary.length > MAX_README_BYTES) throw new Error('Unexpected README size');
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new GitCommitError('The existing problem README could not be read as UTF-8.', { status: 409 });
  }
}

async function writeBlob(api, path, entry, bytes) {
  const response = await api('/blobs', {
    method: 'POST',
    body: { content: encodeBase64(bytes), encoding: 'base64' },
  });
  const blob = await requireOK(response, 'GitHub could not write a solution file.').json();
  return { path, type: 'blob', mode: entry?.mode ?? '100644', sha: objectSha(blob.sha) };
}

export async function commitSubmission({ request, repository, submission }) {
  const name = encodePath(repository.full_name);
  const branch = repository.default_branch;
  const ref = `heads/${encodePath(branch)}`;
  const baseURL = `https://github.com/${name}/blob/${encodeURIComponent(branch)}`;
  const api = (path, options) => request(`/repos/${name}/git${path}`, options);
  const solution = solutionFile(submission);
  const folders = solution.path.split('/');
  const sourceName = folders.pop();
  const source = encoder.encode(solution.content);
  const sourceSha = await gitBlobSha(source);
  let head = await readHead(api, ref, branch);

  for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt += 1) {
    const commitResponse = await api(`/commits/${head}`);
    const commit = await requireOK(commitResponse, 'GitHub could not read the current commit.').json();
    const root = objectSha(commit.tree?.sha);
    const entries = await solutionFolder(api, root, folders);
    const sourceEntry = fileEntry(entries, sourceName, 'solution');
    const readmeEntry = fileEntry(entries, 'README.md', 'README');
    const previousReadme = await readReadme(api, readmeEntry);
    const readme = problemReadme(submission, previousReadme);
    const readmeBytes = encoder.encode(readme.content);
    if (readmeBytes.length > MAX_README_BYTES) {
      throw new GitCommitError('The updated problem README exceeds 2 MiB.', { status: 413 });
    }

    const result = {
      path: solution.path,
      url: `${baseURL}/${encodePath(solution.path)}`,
      readmeUrl: `${baseURL}/${encodePath(readme.path)}`,
    };
    if (readme.superseded && sourceEntry) return { ...result, outcome: 'unchanged' };
    const changes = [];
    if (sourceEntry?.sha !== sourceSha) changes.push([solution.path, sourceEntry, source]);
    if (previousReadme !== readme.content) changes.push([readme.path, readmeEntry, readmeBytes]);
    if (!changes.length) return { ...result, outcome: 'unchanged' };

    const tree = [];
    for (const change of changes) tree.push(await writeBlob(api, ...change));
    const treeResponse = await api('/trees', {
      method: 'POST',
      body: { base_tree: root, tree },
    });
    const newTree = await requireOK(treeResponse, 'GitHub could not assemble the updated files.').json();
    const newResponse = await api('/commits', {
      method: 'POST',
      body: { message: solution.message, tree: objectSha(newTree.sha), parents: [head] },
    });
    const updated = await requireOK(newResponse, 'GitHub could not create the solution commit.').json();
    const update = await api(`/refs/${ref}`, {
      method: 'PATCH',
      body: { sha: objectSha(updated.sha), force: false },
    });
    if (update.ok) return { ...result, outcome: sourceEntry ? 'updated' : 'created' };

    const rejection = 'GitHub rejected the commit. Check whether the default branch allows direct writes.';
    if (![409, 422].includes(update.status)) throw new GitCommitError(rejection, { response: update });
    const currentHead = await readHead(api, ref, branch);
    if (currentHead === head) throw new GitCommitError(rejection, { response: update });
    head = currentHead;
  }

  throw new GitCommitError('The default branch moved repeatedly. LeetGit will retry the sync.', {
    status: 409, retry: true,
  });
}
