import assert from 'node:assert/strict';
import test from 'node:test';
import { problemReadme, solutionFile } from '../extension/solution.js';

const sample = {
  id: '100', slug: 'fixture-problem', language: 'python3', acceptedAt: '2026-11-20T18:00:00Z',
  code: '# exact café example\nprint("```" )\n# a marker is just source code\n<!-- /leetgit:generated -->\n',
  problem: { title: 'Fixture [Problem]', frontendId: '101', difficulty: 'medium', topics: ['Arrays', 'Sorting'],
    paidOnly: false, overview: 'A short description for this fixture.', descriptionMarkdown: 'Full fixture text.\n\n- Example' },
  stats: { runtime: '0 ms', runtimePercentile: 100, memory: '12.5 MB', memoryPercentile: 70.34, testsPassed: 12, totalTests: 12 },
};

test('the README presents problem facts and accepted results alongside exact code', () => {
  const { path, content } = problemReadme(sample);
  assert.equal(path, 'solutions/fixture-problem/README.md');
  assert.ok(content.includes('# 101. Fixture \\[Problem\\]'));
  assert.ok(content.includes('**Medium** · Arrays · Sorting'));
  assert.ok(content.includes('> A short description for this fixture.'));
  assert.ok(content.includes('0 ms (beats 100%) | 12.5 MB (beats 70.34%) | 12/12 | 2026-11-20'));
  assert.ok(content.includes('````python\n' + sample.code + '````'));
  assert.equal(solutionFile(sample).content, sample.code);
  assert.ok(!content.includes('Full fixture text.'));
  assert.equal(problemReadme(sample, content).content, content);
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

test('full problem text is opt-in and is excluded for premium problems', () => {
  const full = problemReadme({ ...sample, includeProblemText: true }).content;
  assert.ok(full.includes('Full fixture text.\n\n- Example'));
  const disabled = problemReadme({ ...sample, id: '103', includeProblemText: false }, full).content;
  assert.ok(!disabled.includes('Full fixture text.'));
  const premium = problemReadme({ ...sample, problem: { ...sample.problem, paidOnly: true }, includeProblemText: true }).content;
  assert.ok(!premium.includes('Full fixture text.'));
  assert.ok(!premium.includes('A short description for this fixture.'));
});
