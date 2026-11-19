import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FORWARD_TARGET_LIMIT, forwardTargets } from '../lib/chatForward.js';

const A = `G${'A'.repeat(55)}`;
const B = `G${'B'.repeat(55)}`;
const C = `G${'C'.repeat(55)}`;

test('the current conversation is not a forward target', () => {
  assert.deepEqual(forwardTargets([A, B, C], A), [B, C]);
});

test('targets are valid, uppercase and de-duplicated in list order', () => {
  assert.deepEqual(forwardTargets([B.toLowerCase(), 'not-an-address', B, C], ''), [B, C]);
  assert.deepEqual(forwardTargets(null, A), []);
});

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const addressAt = (value) => {
  let rest = value;
  let suffix = '';
  for (let i = 0; i < 5; i += 1) {
    suffix = BASE32[rest % 32] + suffix;
    rest = Math.floor(rest / 32);
  }
  return `G${'A'.repeat(50)}${suffix}`;
};

test('the target list is capped', () => {
  const known = Array.from({ length: FORWARD_TARGET_LIMIT + 5 }, (_, index) => addressAt(index));
  assert.equal(new Set(known).size, known.length);
  assert.equal(forwardTargets(known, '').length, FORWARD_TARGET_LIMIT);
});
