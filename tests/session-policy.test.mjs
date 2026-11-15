// Browser-local session age policy: the record the site keeps (uid + timestamp,
// never a token or wallet data), when it counts as stale, and the one-shot
// notice that explains a forced sign-in.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_IDLE_LIMIT_MS, clearSessionExpired, clearSessionRecord, describeSessionPolicy,
  markSessionExpired, readSessionExpired, readSessionRecord, sessionIsStale,
  touchSessionRecord, writeSessionRecord,
} from '../lib/sessionPolicy.js';

const DAY = 24 * 60 * 60 * 1000;

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
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

test('a touched session records the account and the time, and nothing else', () => {
  const storage = memoryStorage();
  assert.equal(readSessionRecord(storage), null);
  const record = touchSessionRecord('uid-1', { now: 1_000, storage });
  assert.deepEqual(record, { uid: 'uid-1', lastSeenAt: 1_000 });
  assert.deepEqual(readSessionRecord(storage), { uid: 'uid-1', lastSeenAt: 1_000 });
  const stored = JSON.parse(storage.map.get('nsat-web-session-v1'));
  assert.deepEqual(Object.keys(stored).sort(), ['lastSeenAt', 'uid']);
});

test('the policy window is 30 days of no use', () => {
  assert.equal(SESSION_IDLE_LIMIT_MS, 30 * DAY);
  const record = { uid: 'uid-1', lastSeenAt: 0 + DAY };
  assert.equal(sessionIsStale(record, { now: DAY + 29 * DAY }), false, '29 days is still fresh');
  assert.equal(sessionIsStale(record, { now: DAY + 30 * DAY }), false, 'exactly at the limit is not stale');
  assert.equal(sessionIsStale(record, { now: DAY + 31 * DAY }), true, '31 days is stale');
});

test('a missing, unreadable or future record is never expired', () => {
  assert.equal(sessionIsStale(null, { now: DAY }), false);
  assert.equal(sessionIsStale({}, { now: DAY }), false);
  assert.equal(sessionIsStale({ uid: 'a', lastSeenAt: 'nope' }, { now: DAY }), false);
  // A clock that moved backwards must not sign anyone out.
  assert.equal(sessionIsStale({ uid: 'a', lastSeenAt: 2 * DAY }, { now: DAY }), false);
  // Blocked storage reads as "no record", so it can never force a sign-out.
  assert.equal(readSessionRecord(blockedStorage()), null);
  assert.equal(sessionIsStale(readSessionRecord(blockedStorage()), { now: DAY }), false);
});

test('corrupt or incomplete storage is ignored instead of throwing', () => {
  assert.equal(readSessionRecord(memoryStorage({ 'nsat-web-session-v1': '{not json' })), null);
  assert.equal(readSessionRecord(memoryStorage({ 'nsat-web-session-v1': '{"uid":"","lastSeenAt":5}' })), null);
  assert.equal(readSessionRecord(memoryStorage({ 'nsat-web-session-v1': '{"uid":"a","lastSeenAt":-2}' })), null);
  assert.equal(writeSessionRecord({ uid: '  ', lastSeenAt: 1 }, memoryStorage()), false);
  assert.equal(writeSessionRecord({ uid: 'a', lastSeenAt: 0 }, memoryStorage()), false);
  assert.equal(touchSessionRecord('', { now: 1, storage: memoryStorage() }), null);
});

test('signing in as another account replaces the record; clearing removes it', () => {
  const storage = memoryStorage();
  touchSessionRecord('uid-1', { now: 1_000, storage });
  touchSessionRecord('uid-2', { now: 2_000, storage });
  assert.deepEqual(readSessionRecord(storage), { uid: 'uid-2', lastSeenAt: 2_000 });
  assert.equal(clearSessionRecord(storage), true);
  assert.equal(readSessionRecord(storage), null);
});

test('the expiry notice survives repeated mounts and clears after a sign-in', () => {
  const storage = memoryStorage();
  assert.equal(readSessionExpired({ now: 5_000, storage }), 0, 'no notice before an expiry');
  assert.equal(markSessionExpired({ now: 5_000, storage }), true);
  // React can mount the gate twice; the second mount must still explain itself.
  assert.equal(readSessionExpired({ now: 5_000, storage }), 5_000);
  assert.equal(readSessionExpired({ now: 6_000, storage }), 5_000);
  assert.equal(clearSessionExpired(storage), true);
  assert.equal(readSessionExpired({ now: 6_000, storage }), 0, 'a sign-in ends the notice');
  assert.equal(readSessionExpired({ storage: blockedStorage() }), 0);
  assert.equal(clearSessionExpired(blockedStorage()), false);
});

test('an old expiry notice expires on its own', () => {
  const storage = memoryStorage();
  markSessionExpired({ now: 1_000, storage });
  assert.equal(readSessionExpired({ now: 1_000 + 6 * DAY, maxAgeMs: 7 * DAY, storage }), 1_000);
  assert.equal(readSessionExpired({ now: 1_000 + 8 * DAY, maxAgeMs: 7 * DAY, storage }), 0);
  assert.equal(storage.map.has('nsat-session-expired-v1'), false, 'an expired notice is removed');
});

test('the policy line says remembered vs session-only', () => {
  assert.match(describeSessionPolicy({ remembered: true }), /30 days without use/);
  assert.match(describeSessionPolicy({ remembered: true }), /sign out/);
  assert.match(describeSessionPolicy({ remembered: false }), /Session-only/);
  assert.doesNotMatch(describeSessionPolicy({ remembered: false }), /30 days/);
});
