// The friend list is the only chat-adjacent thing that touches storage, so it
// gets its own tests: what counts as input, what is stored, and what a stale or
// tampered storage entry is allowed to become.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  FRIEND_LIMIT, addFriend, friendStorageKey, mergeContacts, normalizeFriends,
  parseFriendTarget, readFriends, removeFriend,
} from '../lib/chatFriends.js';

const A = `G${'A'.repeat(55)}`;
const B = `G${'B'.repeat(55)}`;
const C = `G${'C'.repeat(55)}`;
// Base32 strkey alphabet — digits 0, 1, 8 and 9 are not addresses.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const addressAt = (i) => `G${ALPHABET[i % 32]}${ALPHABET[Math.floor(i / 32) % 32]}${'A'.repeat(53)}`;

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    dump: () => Object.fromEntries(map),
  };
}

test('adding a friend accepts a @profile ID or a wallet address, and nothing else', () => {
  assert.deepEqual(parseFriendTarget('@somchai'), { kind: 'id', value: '@somchai' });
  assert.deepEqual(parseFriendTarget('  @Somchai '), { kind: 'id', value: '@somchai' });
  assert.deepEqual(parseFriendTarget(`  ${A.toLowerCase()}  `), { kind: 'address', value: A });

  // A bad @id says what is wrong with it, in the same words the profile card uses.
  assert.match(parseFriendTarget('@ab').error, /at least/);
  assert.match(parseFriendTarget('@has space').error, /letters, digits/);
  // A short or malformed address is refused before anything is stored.
  assert.match(parseFriendTarget('Gsomething').error, /56 characters/);
  assert.match(parseFriendTarget('notanaddress').error, /Start with @|G…/);
  assert.match(parseFriendTarget('   ').error, /Enter a @profile ID/);
  assert.equal(parseFriendTarget(null).error.length > 0, true);
});

test('a stored list keeps only well-formed addresses, in order and without duplicates', () => {
  assert.deepEqual(normalizeFriends([A, A.toLowerCase(), B, 'nonsense', '', null]), [A, B]);
  assert.deepEqual(normalizeFriends('not a list'), []);
  assert.equal(normalizeFriends(Array.from({ length: FRIEND_LIMIT + 10 }, () => A)).length, 1);
  const many = Array.from({ length: FRIEND_LIMIT + 10 }, (_, i) => addressAt(i));
  assert.equal(normalizeFriends(many).length, FRIEND_LIMIT, 'the list is capped');
});

test('transfer contacts come first, then friends, each address once', () => {
  assert.deepEqual(mergeContacts([A, B], [B, C]), [A, B, C]);
  assert.deepEqual(mergeContacts([], [C]), [C]);
  assert.deepEqual(mergeContacts([A], []), [A]);
  assert.deepEqual(mergeContacts(['bad'], ['also bad']), []);
});

test('a friend is stored per wallet address and can be removed again', () => {
  const storage = memoryStorage();
  assert.deepEqual(readFriends(storage, A), [], 'nothing stored yet');

  assert.deepEqual(addFriend(storage, A, B), { friends: [B], added: true });
  assert.deepEqual(readFriends(storage, A), [B]);
  // A different wallet on the same device has its own list.
  assert.deepEqual(readFriends(storage, C), []);
  // The same address twice is reported, not written twice.
  assert.deepEqual(addFriend(storage, A, B.toLowerCase()), { friends: [B], added: false });
  assert.deepEqual(storage.dump()[friendStorageKey(A)], JSON.stringify([B]));

  assert.deepEqual(removeFriend(storage, A, B), []);
  assert.deepEqual(readFriends(storage, A), []);
});

test('the stored list is defensive: damaged JSON or junk entries read as an empty/clean list', () => {
  const damaged = memoryStorage({ [friendStorageKey(A)]: '{not json' });
  assert.deepEqual(readFriends(damaged, A), []);

  const junk = memoryStorage({ [friendStorageKey(A)]: JSON.stringify([A, 'x', 42, { address: A }]) });
  assert.deepEqual(readFriends(junk, A), [A]);

  // No storage (SSR, private mode) must not throw anywhere.
  assert.deepEqual(readFriends(null, A), []);
  assert.deepEqual(addFriend(null, A, B), { friends: [B], added: true });
});

test('the list refuses to grow past its cap instead of silently dropping entries', () => {
  const storage = memoryStorage();
  const addresses = Array.from({ length: FRIEND_LIMIT }, (_, i) => addressAt(i));
  addFriend(storage, A, addresses[0]);
  for (const address of addresses.slice(1)) addFriend(storage, A, address);
  assert.equal(readFriends(storage, A).length, FRIEND_LIMIT);
  assert.throws(() => addFriend(storage, A, addressAt(FRIEND_LIMIT + 5)), (error) => error.code === 'FRIEND_LIMIT');
});

test('the friend list never holds a message, a name or an email', () => {
  const storage = memoryStorage();
  addFriend(storage, A, B);
  const stored = storage.dump()[friendStorageKey(A)];
  assert.deepEqual(JSON.parse(stored), [B]);
  assert.doesNotMatch(stored, /@|message|text|email|seed/i);
});
