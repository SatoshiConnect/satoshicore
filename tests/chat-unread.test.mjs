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

test('read marks and the cursor are scoped to one device, not just one wallet', async () => {
  const {
    CURSOR_KEY, READ_KEY, markPeerSeen, readCursor, readReadMarks, writeCursor,
  } = await import('../lib/chatUnread.js');
  const LAPTOP = 'laptop-device-0001';
  const PHONE = 'phone-device-0001';
  const storage = memoryStorage();

  markPeerSeen(OWNER, PEER, 1_000, storage, LAPTOP);
  assert.deepEqual(readReadMarks(OWNER, storage, LAPTOP), { [PEER]: 1_000 });
  assert.deepEqual(readReadMarks(OWNER, storage, PHONE), {}, 'the phone keeps its own mark');

  assert.equal(writeCursor(OWNER, 42, storage, LAPTOP), 42);
  assert.equal(readCursor(OWNER, storage, LAPTOP), 42);
  assert.equal(readCursor(OWNER, storage, PHONE), 0);

  markPeerSeen(OWNER, PEER, 2_000, storage, PHONE);
  assert.deepEqual(readReadMarks(OWNER, storage, LAPTOP), { [PEER]: 1_000 });

  // State written before device ids existed is still readable as a fallback;
  // the next write lands on the scoped key.
  const legacy = memoryStorage({
    [READ_KEY]: JSON.stringify({ [OWNER]: { [PEER]: 7 } }),
    [CURSOR_KEY]: JSON.stringify({ [OWNER]: 9 }),
  });
  assert.deepEqual(readReadMarks(OWNER, legacy, PHONE), { [PEER]: 7 });
  assert.equal(readCursor(OWNER, legacy, PHONE), 9);
  markPeerSeen(OWNER, PEER, 8, legacy, PHONE);
  assert.deepEqual(readReadMarks(OWNER, legacy, PHONE), { [PEER]: 8 });
  assert.deepEqual(readReadMarks(OWNER, legacy, LAPTOP), { [PEER]: 7 }, 'the old key is untouched');
});

test('the browser device id is stable, validated and stored once', async () => {
  const {
    DEVICE_KEY, DEVICE_RE, getChatDeviceId, normalizeDeviceId,
  } = await import('../lib/chatDevice.js');
  const storage = memoryStorage();
  const first = getChatDeviceId(storage);
  assert.match(first, DEVICE_RE);
  assert.equal(getChatDeviceId(storage), first);
  assert.equal(storage.getItem(DEVICE_KEY), first);

  // A corrupted value is replaced rather than used in a signature.
  storage.setItem(DEVICE_KEY, 'short');
  const repaired = getChatDeviceId(storage);
  assert.match(repaired, DEVICE_RE);
  assert.notEqual(repaired, 'short');
  assert.equal(normalizeDeviceId('short'), '');
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
  const { countNewMessages } = await import('../lib/chatUnread.js');
  const messages = [
    { from: PEER, receivedAt: 100 },
    { from: PEER, receivedAt: 200 },
    { from: PEER2, receivedAt: 150 },
    { from: 'nope', receivedAt: 300 },
  ];
  const rebuild = (marks = {}) => countNewMessages({ messages, marks, reset: true });

  assert.deepEqual(rebuild().counts, { [PEER]: 2, [PEER2]: 1 });
  assert.deepEqual(rebuild({ [PEER]: 100 }).counts, { [PEER]: 1, [PEER2]: 1 });
  assert.deepEqual(rebuild({ [PEER]: 200, [PEER2]: 150 }).counts, {});
  assert.deepEqual(countNewMessages({ messages: [], marks: {} }).counts, {});
  assert.deepEqual(rebuild().newest, { [PEER]: 200, [PEER2]: 150 });

  // Opening a room returns its newest arrival for the read mark, and its own
  // messages do not become a badge.
  const opened = countNewMessages({ messages, openPeer: PEER, reset: true });
  assert.deepEqual(opened.counts, { [PEER2]: 1 });
  assert.equal(opened.newest[PEER], 200);
});

test('a message that arrives while its room is open never becomes a list badge', async () => {
  const {
    countNewMessages, markPeerSeen, readReadMarks,
  } = await import('../lib/chatUnread.js');
  const storage = memoryStorage();
  const arrival = { from: PEER, receivedAt: 1_000 };

  // Poll while the room is open: the line is on screen, so it is not counted,
  // and the batch reports how far the room has been seen.
  const open = countNewMessages({ messages: [arrival], marks: {}, openPeer: PEER, reset: true });
  assert.deepEqual(open.counts, {});
  assert.equal(open.newest[PEER], 1_000);
  markPeerSeen(OWNER, PEER, open.newest[PEER], storage);

  // Back on the list: the next poll asks only after the cursor, fetches nothing,
  // and the badge stays empty.
  const back = countNewMessages({
    messages: [], marks: readReadMarks(OWNER, storage), previous: open.counts,
  });
  assert.deepEqual(back.counts, {});

  // Even rebuilding from the whole mailbox agrees, because the read mark moved.
  const rebuild = countNewMessages({
    messages: [arrival], marks: readReadMarks(OWNER, storage), reset: true,
  });
  assert.deepEqual(rebuild.counts, {});
});

test('a message for another room is counted while one room is open', async () => {
  const { countNewMessages } = await import('../lib/chatUnread.js');
  const { counts, newest } = countNewMessages({
    messages: [{ from: PEER, receivedAt: 100 }, { from: PEER2, receivedAt: 200 }],
    marks: {},
    openPeer: PEER,
    reset: true,
  });
  assert.deepEqual(counts, { [PEER2]: 1 });
  assert.equal(newest[PEER], 100);
});

test('a rebuild never resurrects the badge of the open room', async () => {
  const { countNewMessages } = await import('../lib/chatUnread.js');
  const { counts } = countNewMessages({
    messages: [{ from: PEER, receivedAt: 100 }],
    marks: {},
    openPeer: PEER,
    previous: { [PEER]: 3, [PEER2]: 1 },
    reset: true,
  });
  assert.deepEqual(counts, {});
});

test('a snapshot write notifies local listeners, and the signal carries no text', async () => {
  const {
    subscribeUnreadSnapshots, writeUnreadSnapshot, clearUnreadSnapshot,
  } = await import('../lib/chatUnread.js');
  const storage = memoryStorage();
  let calls = 0;
  const off = subscribeUnreadSnapshots(() => { calls += 1; });

  const saved = writeUnreadSnapshot(OWNER, {
    at: 10, counts: { [PEER]: 2 }, text: 'must not travel', preview: 'hello',
  }, storage);
  assert.deepEqual(saved, { at: 10, counts: { [PEER]: 2 } });
  assert.equal(calls, 1, 'the bottom-nav badge hears about a new count');

  clearUnreadSnapshot(OWNER, storage);
  assert.equal(calls, 2);

  off();
  writeUnreadSnapshot(OWNER, { at: 11, counts: { [PEER]: 1 } }, storage);
  assert.equal(calls, 2, 'an unsubscribed listener is not called');
});

test('a throwing listener cannot break the snapshot write', async () => {
  const { subscribeUnreadSnapshots, writeUnreadSnapshot } = await import('../lib/chatUnread.js');
  const storage = memoryStorage();
  const off = subscribeUnreadSnapshots(() => { throw new Error('boom'); });
  assert.doesNotThrow(() => writeUnreadSnapshot(OWNER, { at: 5, counts: { [PEER]: 1 } }, storage));
  off();
  assert.deepEqual(readUnreadSnapshot(OWNER, storage), { at: 5, counts: { [PEER]: 1 } });
});
