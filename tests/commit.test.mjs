import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { commitSubmission } from '../extension/commit.js';
import { problemReadme } from '../extension/solution.js';

const repository = { full_name: 'owner/repo', default_branch: 'main' };
const submission = {
  id: '101', slug: 'two-sum', language: 'python3', code: '# λ\nreturn a + b\n',
  acceptedAt: '2026-11-20T12:00:00.000Z',
};
const head = 'a'.repeat(40);
const root = 'b'.repeat(40);
const solutionsTree = 'c'.repeat(40);
const problemTree = 'd'.repeat(40);
const existingReadme = 'e'.repeat(40);
const sourcePath = 'solutions/two-sum/python3.py';
const readmePath = 'solutions/two-sum/README.md';

function objectResponse(data, status = 200) {
  return Response.json(data, { status });
}

function gitObject(contents) {
  const buffer = Buffer.from(contents);
  return createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex');
}

function snapshot({ currentHead = head, rootTree = root, readme, code, codeMode = '100644' }) {
  const source = { path: 'python3.py', sha: gitObject(code), type: 'blob', mode: codeMode };
  const readmeObject = { path: 'README.md', sha: existingReadme, type: 'blob', mode: '100644' };
  return {
    '/ref/heads/main': { ref: 'refs/heads/main', object: { type: 'commit', sha: currentHead } },
    [`/commits/${currentHead}`]: { tree: { sha: rootTree } },
    [`/trees/${rootTree}`]: { tree: [{ path: 'solutions', mode: '040000', type: 'tree', sha: solutionsTree }] },
    [`/trees/${solutionsTree}`]: { tree: [{ path: 'two-sum', mode: '040000', type: 'tree', sha: problemTree }] },
    [`/trees/${problemTree}`]: { tree: [source, readmeObject] },
    [`/blobs/${existingReadme}`]: { content: Buffer.from(readme).toString('base64'), encoding: 'base64' },
  };
}

function readOnly(objects) {
  return (path, options) => {
    assert.equal(options, undefined);
    const resource = path.replace(/^\/repos\/owner\/repo\/git/, '');
    assert.ok(objects[resource], `unexpected request ${resource}`);
    return objectResponse(objects[resource]);
  };
}

test('an identical submission replay writes neither a blob nor a commit', async () => {
  const { content: readme } = problemReadme(submission);
  const request = readOnly(snapshot({ readme, code: submission.code }));
  const result = await commitSubmission({ request, repository, submission });
  assert.deepEqual(result, {
    outcome: 'unchanged',
    path: sourcePath,
    url: `https://github.com/owner/repo/blob/main/${sourcePath}`,
    readmeUrl: `https://github.com/owner/repo/blob/main/${readmePath}`,
  });
});

test('an older offline submission does not replace a newer solution', async () => {
  const latest = { ...submission, id: '102', code: 'return b + a\n' };
  const { content: readme } = problemReadme(latest);
  const request = readOnly(snapshot({ readme, code: latest.code }));
  const result = await commitSubmission({ request, repository, submission });
  assert.equal(result.outcome, 'unchanged');
});

test('a destination symlink is left untouched', async () => {
  const request = readOnly(snapshot({ readme: 'manual notes', code: submission.code, codeMode: '120000' }));
  await assert.rejects(commitSubmission({ request, repository, submission }), /not a regular file|other than a regular file/);
});

test('a ref conflict rebuilds the commit from the new head and preserves its README and executable mode', async () => {
  const nextHead = 'f'.repeat(40);
  const nextRoot = '0'.repeat(40);
  const old = snapshot({ readme: 'original notes', code: 'old code' });
  const newer = snapshot({
    currentHead: nextHead,
    rootTree: nextRoot,
    readme: 'original notes\n\nConcurrent note from the owner.',
    code: 'other code',
    codeMode: '100755',
  });
  const assembled = '1'.repeat(40);
  const generated = '2'.repeat(40);
  let refUpdates = 0;
  const newBlobs = [];
  const treePayloads = [];
  const parents = [];
  function request(path, options) {
    const resource = path.replace(/^\/repos\/owner\/repo\/git/, '');
    if (!options) return readOnly(refUpdates === 0 ? old : newer)(path, options);
    if (resource === '/blobs') {
      const contents = Buffer.from(options.body.content, 'base64').toString();
      newBlobs.push(contents);
      return objectResponse({ sha: gitObject(contents) }, 201);
    }
    if (resource === '/trees') {
      treePayloads.push(options.body);
      return objectResponse({ sha: assembled }, 201);
    }
    if (resource === '/commits') {
      parents.push(options.body.parents);
      return objectResponse({ sha: generated }, 201);
    }
    assert.equal(resource, '/refs/heads/main');
    assert.deepEqual(options, { method: 'PATCH', body: { sha: generated, force: false } });
    refUpdates += 1;
    return objectResponse({}, refUpdates === 1 ? 422 : 200);
  }

  const result = await commitSubmission({ request, repository, submission });
  assert.equal(result.outcome, 'updated');
  assert.equal(refUpdates, 2);
  assert.deepEqual(parents, [[head], [nextHead]]);
  assert.equal(treePayloads[1].base_tree, nextRoot);
  assert.equal(treePayloads[1].tree.find(({ path }) => path === sourcePath).mode, '100755');
  assert.match(newBlobs.at(-1), /Concurrent note from the owner/);
  assert.match(newBlobs.at(-1), /python3\.py/);
});
