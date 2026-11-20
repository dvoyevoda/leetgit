import { problemReadme, readmeProblemSlug, solutionFile } from './solution.js';

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

async function readTree(api, sha) {
  const response = await api(`/trees/${sha}`);
  const data = await requireOK(response, 'GitHub could not inspect the solution folder.').json();
  if (!Array.isArray(data.tree) || data.truncated) {
    throw new GitCommitError('GitHub returned an incomplete repository tree.');
  }
  return data.tree;
}

function directory(entry) {
  return entry?.type === 'tree' && entry.mode === '040000';
}

function unavailableFolder() {
  return new GitCommitError(
    'An existing repository path conflicts with this problem folder. Review the solutions directory before retrying.',
    { status: 422 },
  );
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

async function inspectFolder(api, entry) {
  const sha = objectSha(entry.sha);
  const entries = await readTree(api, sha);
  const readmeEntry = fileEntry(entries, 'README.md', 'README');
  const previousReadme = await readReadme(api, readmeEntry);
  return {
    folder: entry.path, sha, entries, readmeEntry, previousReadme,
    slug: readmeProblemSlug(previousReadme),
  };
}

function numberedMatch(path, slug) {
  const suffix = `-${slug}`;
  return path.endsWith(suffix) && /^[1-9]\d{0,9}$/.test(path.slice(0, -suffix.length));
}

async function locateProblem(api, root, slug, preferred) {
  const rootEntries = await readTree(api, root);
  const solutions = rootEntries.find((entry) => entry.path === 'solutions');
  const empty = { folder: preferred, entries: [], previousReadme: null };
  if (!solutions) return empty;
  if (!directory(solutions)) throw unavailableFolder();

  const siblings = await readTree(api, objectSha(solutions.sha));
  const preferredEntry = siblings.find((entry) => entry.path === preferred);
  const numbered = siblings.filter((entry) => directory(entry) && numberedMatch(entry.path, slug));
  const exact = numbered.find((entry) => entry.path === preferred);
  if (!exact && numbered.length > 1) throw unavailableFolder();

  const candidate = exact ?? numbered[0];
  const established = candidate && await inspectFolder(api, candidate);
  // A managed README distinguishes a numbered folder from another problem's old numeric slug.
  if (established?.slug === slug) return established;

  const legacy = siblings.find((entry) => entry.path === slug);
  if (directory(legacy)) {
    const previous = await inspectFolder(api, legacy);
    if (!previous.slug || previous.slug === slug) {
      if (preferred !== slug && !preferredEntry) {
        return { ...previous, folder: preferred, movedFrom: slug, siblings };
      }
      return previous;
    }
  }

  if (preferredEntry || (preferred === slug && established && !established.slug)) {
    throw unavailableFolder();
  }
  return empty;
}

async function writeBlob(api, path, entry, bytes) {
  const response = await api('/blobs', {
    method: 'POST',
    body: { content: encodeBase64(bytes), encoding: 'base64' },
  });
  const blob = await requireOK(response, 'GitHub could not write a solution file.').json();
  return { path, type: 'blob', mode: entry?.mode ?? '100644', sha: objectSha(blob.sha) };
}

async function writeTree(api, root, entries) {
  const body = { tree: entries };
  if (root) body.base_tree = root;
  const response = await api('/trees', { method: 'POST', body });
  const tree = await requireOK(response, 'GitHub could not assemble the updated files.').json();
  return objectSha(tree.sha);
}

async function buildTree(api, root, location, changes) {
  const tree = [];
  for (const { path, entry, bytes } of changes) {
    const relativePath = location.movedFrom ? path.split('/').at(-1) : path;
    tree.push(await writeBlob(api, relativePath, entry, bytes));
  }
  if (!location.movedFrom) return writeTree(api, root, tree);

  // Extend the intact legacy subtree first, then move the whole directory so user notes,
  // other language files, and file modes move with it in the same branch update.
  const movedTree = tree.length ? await writeTree(api, location.sha, tree) : location.sha;
  const siblings = location.siblings.map(({ path, type, mode, sha }) => (
    path === location.movedFrom
      ? { path: location.folder, type, mode, sha: movedTree }
      : { path, type, mode, sha }
  ));
  const solutions = await writeTree(api, null, siblings);
  return writeTree(api, root, [{ path: 'solutions', type: 'tree', mode: '040000', sha: solutions }]);
}

export async function commitSubmission({ request, repository, submission }) {
  const name = encodePath(repository.full_name);
  const branch = repository.default_branch;
  const ref = `heads/${encodePath(branch)}`;
  const baseURL = `https://github.com/${name}/blob/${encodeURIComponent(branch)}`;
  const api = (path, options) => request(`/repos/${name}/git${path}`, options);
  const initial = solutionFile(submission);
  const [, preferred, sourceName] = initial.path.split('/');
  const source = encoder.encode(initial.content);
  const sourceSha = await gitBlobSha(source);
  let head = await readHead(api, ref, branch);

  for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt += 1) {
    const commitResponse = await api(`/commits/${head}`);
    const commit = await requireOK(commitResponse, 'GitHub could not read the current commit.').json();
    const root = objectSha(commit.tree?.sha);
    const location = await locateProblem(api, root, submission.slug, preferred);
    const { folder, entries, readmeEntry, previousReadme, movedFrom } = location;
    const sourceEntry = fileEntry(entries, sourceName, 'solution');
    const solution = folder === preferred ? initial : solutionFile(submission, folder);
    const readme = problemReadme(submission, previousReadme, folder);
    const readmeBytes = encoder.encode(readme.content);
    if (readmeBytes.length > MAX_README_BYTES) {
      throw new GitCommitError('The updated problem README exceeds 2 MiB.', { status: 413 });
    }

    const result = {
      path: solution.path,
      url: `${baseURL}/${encodePath(solution.path)}`,
      readmeUrl: `${baseURL}/${encodePath(readme.path)}`,
    };
    const changes = [];
    if (!readme.superseded || !sourceEntry) {
      if (sourceEntry?.sha !== sourceSha) {
        changes.push({ path: solution.path, entry: sourceEntry, bytes: source });
      }
      if (previousReadme !== readme.content) {
        changes.push({ path: readme.path, entry: readmeEntry, bytes: readmeBytes });
      }
    }
    if (!changes.length && !movedFrom) return { ...result, outcome: 'unchanged' };

    const newTree = await buildTree(api, root, location, changes);
    const newResponse = await api('/commits', {
      method: 'POST',
      body: {
        message: !changes.length ? `Move ${movedFrom} to ${folder}` : solution.message,
        tree: newTree,
        parents: [head],
      },
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
