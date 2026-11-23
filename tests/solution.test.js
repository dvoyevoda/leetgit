import assert from 'node:assert/strict';
import test from 'node:test';
import { problemFolder, problemReadme, solutionFile } from '../extension/solution.js';

const sample = {
  id: '100', slug: 'fixture-problem', language: 'python3', acceptedAt: '2026-11-20T18:00:00Z',
  code: '# exact café example\nprint("```" )\n# a marker is just source code\n<!-- /leetgit:generated -->\n',
  problem: { title: 'Fixture [Problem]', frontendId: '101', difficulty: 'medium', topics: ['Arrays', 'Sorting'],
    paidOnly: false, overview: 'A short description for this fixture.', descriptionMarkdown: 'Full fixture text.\n\n- Example' },
  stats: { runtime: '0 ms', runtimePercentile: 100, memory: '12.5 MB', memoryPercentile: 70.34, testsPassed: 12, totalTests: 12 },
};

test('the README presents problem facts and accepted results alongside exact code', () => {
  const { path, content } = problemReadme(sample);
  assert.equal(path, '101-fixture-problem/README.md');
  assert.ok(content.includes('# 101. Fixture \\[Problem\\]'));
  assert.ok(content.includes('[View on LeetCode](https://leetcode.com/problems/fixture-problem/)'));
  assert.ok(content.includes('**Topics** · Arrays · Sorting'));
  assert.ok(content.includes('> A short description for this fixture.'));
  assert.ok(content.includes('0 ms (beats 100%) | 12.5 MB (beats 70.34%) | 12/12 | 2026-11-20'));
  assert.ok(content.includes('````python\n' + sample.code + '````'));
  assert.equal(solutionFile(sample).content, sample.code);
  assert.ok(!content.includes('Full fixture text.'));
  assert.equal(problemReadme(sample, content).content, content);
});

test('folder names normalize the LeetCode display number and fall back to a safe slug', () => {
  assert.equal(problemFolder({ ...sample, problem: { frontendId: '000101' } }), '101-fixture-problem');
  assert.equal(problemFolder({ ...sample, problem: { frontendId: 'LCP 01' } }), 'fixture-problem');
  assert.equal(solutionFile(sample).path, '101-fixture-problem/python3.py');
  assert.equal(solutionFile(sample, 'solutions/101-fixture-problem').path, 'solutions/101-fixture-problem/python3.py');
  assert.equal(problemReadme(sample, null, 'solutions/101-fixture-problem').path, 'solutions/101-fixture-problem/README.md');
});

test('the README shows a labeled color badge only when LeetCode reports the difficulty', () => {
  for (const [difficulty, color] of [['Easy', '137B59'], ['Medium', 'A65E00'], ['Hard', 'BC303C']]) {
    const { content } = problemReadme({ ...sample, problem: { ...sample.problem, difficulty } });
    assert.ok(content.includes(
      `![${difficulty} difficulty](https://img.shields.io/badge/Difficulty-${difficulty}-${color}?labelColor=35383D)`,
    ));
  }
  const { content } = problemReadme({ ...sample, problem: undefined });
  assert.ok(!content.includes('img.shields.io'));
  assert.ok(!content.includes('## Problem'));
  assert.ok(content.includes('[View on LeetCode](https://leetcode.com/problems/fixture-problem/)'));
});

test('a distinct result updates the README, preserving other languages, custom notes, and replay order', () => {
  const notes = '# My notes\n\nOriginal problem-solving notes.\n<!-- leetgit:generated -->\nA marker from a scratch note.\n';
  const first = problemReadme(sample, notes).content;
  const newer = { ...sample, language: 'javascript', id: '101', code: 'console.log("fixture")\n' };
  const updated = problemReadme(newer, first + '\nA new note below the managed section.\n').content;
  assert.ok(updated.startsWith(notes));
  assert.ok(updated.endsWith('\nA new note below the managed section.\n'));
  assert.ok(updated.includes('[Python 3](python3.py)'));
  assert.ok(updated.includes('[JavaScript](javascript.js)'));
  assert.ok(updated.includes('## Solution · JavaScript'));
  assert.equal(problemReadme(sample, updated).content, updated);
  assert.equal(problemReadme({ ...newer, id: '99' }, updated).superseded, true);
});

test('the README honors the full-text setting and excludes premium problem descriptions', () => {
  const full = problemReadme({ ...sample, includeProblemText: true }).content;
  assert.ok(full.includes('Full fixture text.\n\n- Example'));
  const disabled = problemReadme({ ...sample, id: '103', includeProblemText: false }, full).content;
  assert.ok(!disabled.includes('Full fixture text.'));
  const premium = problemReadme({ ...sample, problem: { ...sample.problem, paidOnly: true }, includeProblemText: true }).content;
  assert.ok(!premium.includes('Full fixture text.'));
  assert.ok(!premium.includes('A short description for this fixture.'));
});
