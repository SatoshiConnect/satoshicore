import assert from 'node:assert/strict';
import test from 'node:test';

import { isMuted, readMuted, toggleMuted } from '../lib/chatMute.js';

const A = `G${'A'.repeat(55)}`;
const B = `G${'B'.repeat(55)}`;

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
  };
}

test('mute is scoped per wallet and toggles without duplicates', () => {
  const storage = memoryStorage();
  assert.deepEqual(readMuted('GW', storage), []);
  toggleMuted('GW', A, storage);
  assert.equal(isMuted('GW', A, storage), true);
  toggleMuted('GW', A, storage);
  assert.equal(isMuted('GW', A, storage), false);
  assert.equal(isMuted('GX', A, storage), false);
  assert.equal(isMuted('GW', 'Gshort', storage), false);
});
