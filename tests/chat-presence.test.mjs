import assert from 'node:assert/strict';
import test from 'node:test';

import { readPresencePref, writePresencePref } from '../lib/chatPresence.js';

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
  };
}

test('presence is off by default and opt-in is per wallet', () => {
  const storage = memoryStorage();
  assert.equal(readPresencePref('GA', storage), false);
  writePresencePref('ga', true, storage);
  assert.equal(readPresencePref('GA', storage), true);
  assert.equal(readPresencePref('GB', storage), false);
  writePresencePref('GA', false, storage);
  assert.equal(readPresencePref('GA', storage), false);
});

test('corrupt presence preferences fail closed', () => {
  const storage = memoryStorage();
  storage.setItem('scw-chat-presence-v1', '{');
  assert.equal(readPresencePref('GA', storage), false);
  assert.equal(writePresencePref('', true, storage), false);
});
