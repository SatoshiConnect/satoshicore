import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  UNREAD_KEY, clearUnreadSnapshot, formatUnreadAge, mergeUnreadSnapshots,
  readUnreadSnapshot, writeUnreadSnapshot,
} from '../lib/chatUnread.js';

const OWNER = `G${'A'.repeat(55)}`;
const OTHER_OWNER = `G${'B'.repeat(55)}`;
const PEER = `G${'C'.repeat(55)}`;
const PEER2 = `G${'D'.repeat(55)}`;

const memoryStorage = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    raw: () => map,
  };
};

test('an unread snapshot keeps addresses, counts and a time only', () => {
  const storage = memoryStorage();
  assert.deepEqual(readUnreadSnapshot(OWNER, storage), { at: 0, counts: {} });

  const saved = writeUnreadSnapshot(OWNER, {
    at: 1_794_810_000_000,
    counts: { [PEER]: 2, [PEER2]: 1 },
    text: 'must never be stored',
    previews: { [PEER]: 'hello' },
  }, storage);
  assert.deepEqual(saved, { at: 1_794_810_000_000, counts: { [PEER]: 2, [PEER2]: 1 } });

  const raw = storage.getItem(UNREAD_KEY);
  assert.equal(raw.includes('must never be stored'), false);
  assert.equal(raw.includes('hello'), false);
  assert.deepEqual(Object.keys(JSON.parse(raw)[OWNER]), ['at', 'counts']);

  assert.deepEqual(readUnreadSnapshot(OWNER, storage), saved);
});

test('bad addresses and non-positive counts are dropped, not stored', () => {
  const storage = memoryStorage();
  writeUnreadSnapshot(OWNER, {
    at: 1,
    counts: {
      [PEER]: 3,
      'not-an-address': 5,
      [PEER2]: 0,
      [`G${'E'.repeat(55)}`]: -2,
      [`G${'F'.repeat(55)}`]: 'lots',
    },
  }, storage);
  assert.deepEqual(readUnreadSnapshot(OWNER, storage), { at: 1, counts: { [PEER]: 3 } });
});

test('a snapshot for another wallet is not mixed into this one', () => {
  const storage = memoryStorage();
  writeUnreadSnapshot(OWNER, { at: 10, counts: { [PEER]: 1 } }, storage);
  writeUnreadSnapshot(OTHER_OWNER, { at: 20, counts: { [PEER2]: 4 } }, storage);
  assert.deepEqual(readUnreadSnapshot(OWNER, storage), { at: 10, counts: { [PEER]: 1 } });
  assert.deepEqual(readUnreadSnapshot(OTHER_OWNER, storage), { at: 20, counts: { [PEER2]: 4 } });
});

test('the locked list merges wallets: counts add up, the newest check wins', () => {
  const storage = memoryStorage();
  writeUnreadSnapshot(OWNER, { at: 100, counts: { [PEER]: 1, [PEER2]: 2 } }, storage);
  writeUnreadSnapshot(OTHER_OWNER, { at: 300, counts: { [PEER]: 4 } }, storage);
  assert.deepEqual(mergeUnreadSnapshots([OWNER, OTHER_OWNER], storage), {
    at: 300,
    counts: { [PEER]: 5, [PEER2]: 2 },
  });
  assert.deepEqual(mergeUnreadSnapshots([], storage), { at: 0, counts: {} });
});

test('clearing removes exactly one wallet snapshot', () => {
  const storage = memoryStorage();
  writeUnreadSnapshot(OWNER, { at: 10, counts: { [PEER]: 1 } }, storage);
  writeUnreadSnapshot(OTHER_OWNER, { at: 20, counts: { [PEER]: 2 } }, storage);
  clearUnreadSnapshot(OWNER, storage);
  assert.deepEqual(readUnreadSnapshot(OWNER, storage), { at: 0, counts: {} });
  assert.deepEqual(readUnreadSnapshot(OTHER_OWNER, storage), { at: 20, counts: { [PEER]: 2 } });
});

test('a corrupted snapshot reads as empty instead of throwing', () => {
  const storage = memoryStorage({ [UNREAD_KEY]: '{not json' });
  assert.deepEqual(readUnreadSnapshot(OWNER, storage), { at: 0, counts: {} });
  assert.deepEqual(mergeUnreadSnapshots([OWNER], storage), { at: 0, counts: {} });
});

test('the checked-at label is short and honest', () => {
  const now = 1_794_810_000_000;
  assert.equal(formatUnreadAge(0, now), '');
  assert.equal(formatUnreadAge(now - 10_000, now), 'just now');
  assert.equal(formatUnreadAge(now - 4 * 60_000, now), '4m ago');
  assert.equal(formatUnreadAge(now - 3 * 3_600_000, now), '3h ago');
  assert.equal(formatUnreadAge(now - 2 * 86_400_000, now), '2d ago');
});

test('a read mark is per device and per wallet, and only moves forward', async () => {
  const {
    clearReadMarks, markPeerSeen, readReadMarks, READ_KEY,
  } = await import('../lib/chatUnread.js');
  const storage = memoryStorage();
  assert.deepEqual(readReadMarks(OWNER, storage), {});

  markPeerSeen(OWNER, PEER, 1_000, storage);
  markPeerSeen(OWNER, PEER, 500, storage); // an older batch must not un-read
  assert.deepEqual(readReadMarks(OWNER, storage), { [PEER]: 1_000 });
  assert.deepEqual(readReadMarks(OTHER_OWNER, storage), {}, 'another wallet keeps its own marks');

  // A reload reads the same file-backed value.
  assert.deepEqual(readReadMarks(OWNER, memoryStorage({ [READ_KEY]: storage.getItem(READ_KEY) })), { [PEER]: 1_000 });

  clearReadMarks(OWNER, storage);
  assert.deepEqual(readReadMarks(OWNER, storage), {});
});

test('read marks drop junk and a bad write leaves the old marks alone', async () => {
  const { markPeerSeen, readReadMarks, READ_KEY } = await import('../lib/chatUnread.js');
  const storage = memoryStorage({
    [READ_KEY]: JSON.stringify({
      [OWNER]: { [PEER]: 10, 'not-an-address': 20, [PEER2]: -3, [`G${'E'.repeat(55)}`]: 'x' },
    }),
  });
  assert.deepEqual(readReadMarks(OWNER, storage), { [PEER]: 10 });
  markPeerSeen(OWNER, 'Gshort', 99, storage);
  markPeerSeen(OWNER, PEER, 0, storage);
  assert.deepEqual(readReadMarks(OWNER, storage), { [PEER]: 10 });
});

test('the fetch cursor remembers the highest relay id for this device', async () => {
  const { CURSOR_KEY, readCursor, writeCursor } = await import('../lib/chatUnread.js');
  const storage = memoryStorage();
  assert.equal(readCursor(OWNER, storage), 0);
  assert.equal(writeCursor(OWNER, 42, storage), 42);
  assert.equal(writeCursor(OWNER, 7, storage), 42, 'a stale page never rewinds the cursor');
  assert.equal(readCursor(OWNER, storage), 42);
  assert.equal(readCursor(OTHER_OWNER, storage), 0);

  assert.equal(writeCursor(OWNER, 0, storage), 42);
  assert.equal(writeCursor(OWNER, 'nope', storage), 42);
  assert.equal(writeCursor('Gshort', 100, storage), 0);

  const corrupted = memoryStorage({ [CURSOR_KEY]: '{bad' });
  assert.equal(readCursor(OWNER, corrupted), 0);
});

test('unread counts only what arrived after this device last read the room', async () => {
  const { countUnread, newestArrivalByPeer } = await import('../lib/chatUnread.js');
  const messages = [
    { from: PEER, receivedAt: 100 },
    { from: PEER, receivedAt: 200 },
    { from: PEER2, receivedAt: 150 },
    { from: 'nope', receivedAt: 300 },
  ];
  assert.deepEqual(countUnread(messages, {}), { [PEER]: 2, [PEER2]: 1 });
  assert.deepEqual(countUnread(messages, { [PEER]: 100 }), { [PEER]: 1, [PEER2]: 1 });
  assert.deepEqual(countUnread(messages, { [PEER]: 200, [PEER2]: 150 }), {});
  assert.deepEqual(countUnread([], {}), {});
  assert.deepEqual(newestArrivalByPeer(messages), { [PEER]: 200, [PEER2]: 150 });
});
