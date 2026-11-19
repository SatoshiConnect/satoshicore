import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAT_PIN_LIMIT, CHAT_PINS_PREFIX, isPinned, readPinned, togglePin,
} from '../lib/chatPins.js';

const OWNER = `G${'A'.repeat(55)}`;
const PEER = `G${'B'.repeat(55)}`;
const OTHER = `G${'C'.repeat(55)}`;

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    map,
  };
}

function blockedStorage() {
  return {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
    removeItem: () => { throw new Error('blocked'); },
  };
}

test('a conversation can be pinned and unpinned for one wallet', () => {
  const storage = memoryStorage();
  assert.deepEqual(readPinned(storage, OWNER), []);
  assert.equal(isPinned(storage, OWNER, PEER), false);

  const added = togglePin(storage, OWNER, PEER);
  assert.equal(added.pinned, true);
  assert.deepEqual(added.pins, [PEER]);
  assert.deepEqual(readPinned(storage, OWNER), [PEER]);
  assert.equal(isPinned(storage, OWNER, PEER), true);

  const removed = togglePin(storage, OWNER, PEER);
  assert.equal(removed.pinned, false);
  assert.deepEqual(readPinned(storage, OWNER), []);
});

test('pins are per wallet and addresses are normalized to uppercase', () => {
  const storage = memoryStorage();
  togglePin(storage, OWNER, PEER.toLowerCase());
  assert.deepEqual(readPinned(storage, OWNER), [PEER]);
  assert.deepEqual(readPinned(storage, OTHER), []);
  assert.equal(storage.map.has(`${CHAT_PINS_PREFIX}${OWNER}`), true);
});

test('the stored order is stable and duplicates are dropped', () => {
  const storage = memoryStorage({
    [`${CHAT_PINS_PREFIX}${OWNER}`]: JSON.stringify([PEER, PEER, OTHER]),
  });
  assert.deepEqual(readPinned(storage, OWNER), [PEER, OTHER]);
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

test('the pin list is capped without dropping existing pins', () => {
  const storage = memoryStorage();
  for (let i = 0; i < CHAT_PIN_LIMIT; i += 1) {
    togglePin(storage, OWNER, addressAt(i));
  }
  assert.equal(readPinned(storage, OWNER).length, CHAT_PIN_LIMIT);
  const overflow = togglePin(storage, OWNER, PEER);
  assert.equal(overflow.error, 'LIMIT');
  assert.equal(overflow.pinned, false);
  assert.equal(readPinned(storage, OWNER).length, CHAT_PIN_LIMIT);
});

test('invalid addresses, blocked storage and corrupt values never throw', () => {
  const storage = memoryStorage({ [`${CHAT_PINS_PREFIX}${OWNER}`]: '{not json' });
  assert.deepEqual(readPinned(storage, OWNER), []);
  assert.deepEqual(togglePin(storage, OWNER, 'not-an-address').pins, []);
  assert.deepEqual(readPinned(blockedStorage(), OWNER), []);
  assert.equal(isPinned(blockedStorage(), OWNER, PEER), false);
  assert.doesNotThrow(() => togglePin(blockedStorage(), OWNER, PEER));
  assert.deepEqual(readPinned(null, OWNER), []);
});
