import assert from 'node:assert/strict';
import test from 'node:test';
import { problemStatus, rememberProblemResult } from '../extension/problem-status.js';

test('per-problem results retain their own metrics after other solves and older retries', () => {
  const legacy = { id: '12', slug: 'two-sum', stats: { runtime: '1 ms' } };
  const state = { connection: {}, pending: [], last: legacy, error: null, syncedProblems: ['older-solve', 'two-sum'] };
  const second = { id: '15', slug: 'add-two-numbers', stats: { runtime: '3 ms' } };
  rememberProblemResult(state, second);
  rememberProblemResult(state, { id: '10', slug: 'two-sum', stats: { runtime: '8 ms' } });
  assert.equal(problemStatus(state, 'two-sum').last, legacy);
  assert.equal(problemStatus(state, 'add-two-numbers').last, second);
  assert.deepEqual(problemStatus(state, 'older-solve'), { pending: 0, error: null, last: null, saved: true });
  assert.deepEqual(problemStatus(state, 'constructor'), { pending: 0, error: null, last: null, saved: false });
  assert.deepEqual(problemStatus(state, null), { pending: 0, error: null, last: null, saved: false });
});
