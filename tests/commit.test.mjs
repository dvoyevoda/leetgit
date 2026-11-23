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

function snapshot({ currentHead = head, rootTree = root, readme, code, codeMode = '100644', folder = 'two-sum', atRoot = false }) {
  const source = { path: 'python3.py', sha: gitObject(code), type: 'blob', mode: codeMode };
  const readmeObject = { path: 'README.md', sha: existingReadme, type: 'blob', mode: '100644' };
  const problem = { path: folder, mode: '040000', type: 'tree', sha: problemTree };
  const solutions = { path: 'solutions', mode: '040000', type: 'tree', sha: solutionsTree };
  return {
    '/ref/heads/main': { ref: 'refs/heads/main', object: { type: 'commit', sha: currentHead } },
    [`/commits/${currentHead}`]: { tree: { sha: rootTree } },
    [`/trees/${rootTree}`]: { tree: [atRoot ? problem : solutions] },
    ...(!atRoot && { [`/trees/${solutionsTree}`]: { tree: [problem] } }),
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

test('new problems use solutions by default and the root when explicitly selected', async () => {
  const responses = {
    '/ref/heads/main': { ref: 'refs/heads/main', object: { type: 'commit', sha: head } },
    [`/commits/${head}`]: { tree: { sha: root } },
    [`/trees/${root}`]: { tree: [] },
  };
  const numbered = { ...submission, problem: { frontendId: '1' } };

  for (const [saveAtRoot, folder] of [[undefined, 'solutions/1-two-sum'], [true, '1-two-sum']]) {
    const paths = [];
    const request = (path, options) => {
      if (!options) return readOnly(responses)(path, options);
      const resource = path.replace(/^\/repos\/owner\/repo\/git/, '');
      if (resource === '/blobs') {
        return objectResponse({ sha: gitObject(Buffer.from(options.body.content, 'base64')) });
      }
      if (resource === '/trees') {
        assert.equal(options.body.base_tree, root);
        paths.push(...options.body.tree.map((entry) => entry.path));
        return objectResponse({ sha: root });
      }
      if (resource === '/commits') return objectResponse({ sha: head });
      assert.equal(resource, '/refs/heads/main');
      return objectResponse({});
    };

    const result = await commitSubmission({ request, repository, submission: { ...numbered, saveAtRoot } });
    assert.equal(result.outcome, 'created');
    assert.equal(result.path, `${folder}/python3.py`);
    assert.equal(result.readmeUrl, `https://github.com/owner/repo/blob/main/${folder}/README.md`);
    assert.deepEqual(paths, [`${folder}/python3.py`, `${folder}/README.md`]);
  }
});

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

test('a numbered folder remains authoritative when problem metadata is unavailable', async () => {
  const numbered = { ...submission, problem: { frontendId: '1' } };
  const { content: readme } = problemReadme(numbered);
  const request = readOnly(snapshot({ readme, code: submission.code, folder: '1-two-sum' }));

  const result = await commitSubmission({ request, repository, submission: { ...submission, saveAtRoot: true } });
  assert.equal(result.outcome, 'unchanged');
  assert.equal(result.path, 'solutions/1-two-sum/python3.py');
  assert.equal(result.readmeUrl, 'https://github.com/owner/repo/blob/main/solutions/1-two-sum/README.md');
});

test('the selected location takes precedence when both contain the same problem', async () => {
  const numbered = { ...submission, problem: { frontendId: '1' } };
  const { content: readme } = problemReadme(numbered);
  const responses = snapshot({ readme, code: submission.code, folder: '1-two-sum', atRoot: true });
  responses[`/trees/${root}`].tree.push({ path: 'solutions', mode: '040000', type: 'tree', sha: solutionsTree });
  responses[`/trees/${solutionsTree}`] = { tree: [responses[`/trees/${root}`].tree[0]] };

  for (const [saveAtRoot, prefix] of [[false, 'solutions/'], [true, '']]) {
    const result = await commitSubmission({
      request: readOnly(responses), repository, submission: { ...numbered, saveAtRoot },
    });
    assert.equal(result.outcome, 'unchanged');
    assert.equal(result.path, `${prefix}1-two-sum/python3.py`);
  }
});

test('a root folder with an unrelated README is left untouched', async () => {
  const numbered = { ...submission, problem: { frontendId: '1' }, saveAtRoot: true };
  const responses = snapshot({
    readme: 'See https://leetcode.com/problems/two-sum-ii/', code: 'unrelated file', folder: '1-two-sum', atRoot: true,
  });
  await assert.rejects(commitSubmission({ request: readOnly(responses), repository, submission: numbered }), { status: 422 });
});

test('a blocked default location can reuse a matching root folder', async () => {
  const numbered = { ...submission, problem: { frontendId: '1' } };
  const { content: readme } = problemReadme(numbered);
  const responses = snapshot({ readme, code: submission.code, folder: '1-two-sum', atRoot: true });
  responses[`/trees/${root}`].tree.push({ path: 'solutions', mode: '100644', type: 'blob', sha: solutionsTree });
  const request = readOnly(responses);

  const result = await commitSubmission({ request, repository, submission: numbered });
  assert.equal(result.path, '1-two-sum/python3.py');
  await assert.rejects(commitSubmission({
    request, repository, submission: { ...numbered, slug: 'add-two-numbers', problem: { frontendId: '2' } },
  }), { status: 422 });
});

test('a numbered sync moves the untouched parts of a legacy folder in the same commit', async () => {
  const numbered = { ...submission, id: '102', problem: { frontendId: '0001' } };
  const { content: oldReadme } = problemReadme(submission, 'My approach notes\n');
  const responses = snapshot({ readme: oldReadme, code: submission.code });
  const otherProblem = { path: 'unrelated', mode: '040000', type: 'tree', sha: 'f'.repeat(40) };
  responses[`/trees/${solutionsTree}`].tree.push(otherProblem);
  responses[`/trees/${problemTree}`].tree.push({
    path: 'notes.txt', mode: '100644', type: 'blob', sha: '0'.repeat(40),
  });
  const newFolderSha = '1'.repeat(40);
  const newSolutionsSha = '2'.repeat(40);
  const newRootSha = '3'.repeat(40);
  const newCommitSha = '4'.repeat(40);
  const treeWrites = [];
  const newBlobs = [];
  let updatedRef = 0;

  function request(path, options) {
    const resource = path.replace(/^\/repos\/owner\/repo\/git/, '');
    if (!options) return readOnly(responses)(path, options);
    if (resource === '/blobs') {
      const content = Buffer.from(options.body.content, 'base64').toString();
      newBlobs.push(content);
      return objectResponse({ sha: gitObject(content) }, 201);
    }
    if (resource === '/trees') {
      const sha = [newFolderSha, newSolutionsSha, newRootSha][treeWrites.length];
      treeWrites.push(options.body);
      return objectResponse({ sha }, 201);
    }
    if (resource === '/commits') {
      assert.deepEqual(options.body.parents, [head]);
      assert.equal(options.body.tree, newRootSha);
      return objectResponse({ sha: newCommitSha }, 201);
    }
    assert.equal(resource, '/refs/heads/main');
    assert.deepEqual(options.body, { sha: newCommitSha, force: false });
    updatedRef += 1;
    return objectResponse({});
  }

  const result = await commitSubmission({ request, repository, submission: numbered });
  assert.equal(result.outcome, 'updated');
  assert.equal(result.path, 'solutions/1-two-sum/python3.py');
  assert.equal(updatedRef, 1);
  assert.equal(newBlobs.length, 1);
  assert.match(newBlobs[0], /My approach notes/);
  assert.deepEqual(treeWrites, [
    { base_tree: problemTree, tree: [{ path: 'README.md', mode: '100644', type: 'blob', sha: gitObject(newBlobs[0]) }] },
    { tree: [{ path: '1-two-sum', mode: '040000', type: 'tree', sha: newFolderSha }, otherProblem] },
    { base_tree: root, tree: [{ path: 'solutions', mode: '040000', type: 'tree', sha: newSolutionsSha }] },
  ]);
});

test('a numbered path claimed by another problem leaves the legacy folder in place', async () => {
  const numbered = { ...submission, problem: { frontendId: '1' } };
  const { content: readme } = problemReadme(numbered, null, 'two-sum');
  const { content: foreignReadme } = problemReadme({ ...submission, slug: '1-two-sum' });
  const responses = snapshot({ readme, code: submission.code });
  const foreignTree = 'f'.repeat(40);
  const foreignBlob = '0'.repeat(40);
  responses[`/trees/${solutionsTree}`].tree.push({
    path: '1-two-sum', mode: '040000', type: 'tree', sha: foreignTree,
  });
  responses[`/trees/${foreignTree}`] = { tree: [{ path: 'README.md', mode: '100644', type: 'blob', sha: foreignBlob }] };
  responses[`/blobs/${foreignBlob}`] = { content: Buffer.from(foreignReadme).toString('base64'), encoding: 'base64' };

  const result = await commitSubmission({ request: readOnly(responses), repository, submission: numbered });
  assert.equal(result.outcome, 'unchanged');
  assert.equal(result.path, 'solutions/two-sum/python3.py');
});

test('an older numbered submission can rename a root directory without replacing its files', async () => {
  const latest = { ...submission, id: '102', code: 'return b + a\n' };
  const { content: readme } = problemReadme(latest);
  const responses = snapshot({ readme, code: latest.code, atRoot: true });
  const newRootSha = '0'.repeat(40);
  const newCommitSha = '1'.repeat(40);
  const writes = [];
  function request(path, options) {
    const resource = path.replace(/^\/repos\/owner\/repo\/git/, '');
    if (!options) return readOnly(responses)(path, options);
    writes.push(resource);
    if (resource === '/trees') {
      assert.deepEqual(options.body, {
        base_tree: root,
        tree: [
          { path: 'two-sum', mode: '040000', type: 'tree', sha: null },
          { path: '1-two-sum', mode: '040000', type: 'tree', sha: problemTree },
        ],
      });
      return objectResponse({ sha: newRootSha }, 201);
    }
    if (resource === '/commits') return objectResponse({ sha: newCommitSha }, 201);
    assert.equal(resource, '/refs/heads/main');
    return objectResponse({});
  }

  const numbered = { ...submission, problem: { frontendId: '1' } };
  const result = await commitSubmission({ request, repository, submission: numbered });
  assert.equal(result.outcome, 'updated');
  assert.equal(result.path, '1-two-sum/python3.py');
  assert.deepEqual(writes, ['/trees', '/commits', '/refs/heads/main']);
});

test('a destination symlink is left untouched', async () => {
  const request = readOnly(snapshot({ readme: 'manual notes', code: submission.code, codeMode: '120000' }));
  await assert.rejects(commitSubmission({ request, repository, submission }), /not a regular file|other than a regular file/);
});

test('a ref conflict rebuilds the commit from the new head and preserves its README and executable mode', async () => {
  const nextHead = 'f'.repeat(40);
  const nextRoot = '0'.repeat(40);
  const notes = 'Problem: https://leetcode.com/problems/two-sum/\n\nOriginal notes';
  const old = snapshot({ readme: notes, code: 'old code', atRoot: true, folder: '0001-two-sum' });
  const newer = snapshot({
    currentHead: nextHead,
    rootTree: nextRoot,
    readme: `${notes}\n\nConcurrent note from the owner.`,
    code: 'other code',
    codeMode: '100755',
    atRoot: true,
    folder: '0001-two-sum',
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
  assert.equal(result.path, '0001-two-sum/python3.py');
  assert.equal(treePayloads[1].tree.find(({ path }) => path === result.path).mode, '100755');
  assert.match(newBlobs.at(-1), /Concurrent note from the owner/);
  assert.match(newBlobs.at(-1), /python3\.py/);
});
