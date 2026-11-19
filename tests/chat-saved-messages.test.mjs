// Saved Messages is the wallet's own room. These tests pin the two things that
// make it safe to keep beside normal chats: it is never a contact, and it never
// produces an unread badge or a read receipt.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SAVED_MESSAGES_LABEL, isSavedMessagesPeer, readReceiptLabel, savedMessagesAddress,
} from '../lib/chatSavedMessages.js';
import {
  UNREAD_KEY, countNewMessages, mergeUnreadSnapshots, readUnreadSnapshot,
  withoutSelfUnread, writeUnreadSnapshot,
} from '../lib/chatUnread.js';

const OWNER = `G${'A'.repeat(55)}`;
const OTHER_OWNER = `G${'B'.repeat(55)}`;
const PEER = `G${'C'.repeat(55)}`;

const memoryStorage = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    raw: () => map,
  };
};

test('Saved Messages is the wallet its own address', () => {
  assert.equal(savedMessagesAddress(OWNER), OWNER);
  assert.equal(savedMessagesAddress(OWNER.toLowerCase()), OWNER, 'a pasted address still works');
  assert.equal(savedMessagesAddress(` ${OWNER} `), OWNER);
  assert.equal(savedMessagesAddress(''), '');
  assert.equal(savedMessagesAddress('Gshort'), '');
  assert.equal(savedMessagesAddress(null), '');
  assert.equal(SAVED_MESSAGES_LABEL, 'Saved Messages');
});

test('only this wallet is its own saved-messages peer', () => {
  assert.equal(isSavedMessagesPeer(OWNER, OWNER), true);
  assert.equal(isSavedMessagesPeer(OWNER, OWNER.toLowerCase()), true);
  assert.equal(isSavedMessagesPeer(OWNER, PEER), false);
  assert.equal(isSavedMessagesPeer(OWNER, ''), false);
  assert.equal(isSavedMessagesPeer(OWNER, 'Gshort'), false);
  assert.equal(isSavedMessagesPeer('', ''), false, 'an unknown wallet has no saved room');
});

test('a saved message never shows Sent or Read', () => {
  assert.equal(readReceiptLabel({ owner: OWNER, peer: OWNER, messageId: 5, lastId: 9 }), '');
  assert.equal(readReceiptLabel({ owner: OWNER, peer: PEER, messageId: 5, lastId: 0 }), 'Sent');
  assert.equal(readReceiptLabel({ owner: OWNER, peer: PEER, messageId: 5, lastId: 5 }), 'Read');
  assert.equal(readReceiptLabel({ owner: OWNER, peer: PEER, messageId: 5, lastId: 4 }), 'Sent');
  assert.equal(readReceiptLabel({ owner: OWNER, peer: PEER, messageId: 0, lastId: 9 }), '');
  assert.equal(readReceiptLabel({ owner: OWNER, peer: PEER, messageId: 'm5', lastId: 9 }), '');
  assert.equal(readReceiptLabel({ owner: OWNER, peer: '', messageId: 5, lastId: 9 }), '');
});

test('the wallet’s own room is removed from counts without touching other rooms', () => {
  const previous = { [OWNER]: 3, [PEER]: 2 };
  assert.deepEqual(withoutSelfUnread(previous, OWNER), { [PEER]: 2 });
  assert.deepEqual(previous, { [OWNER]: 3, [PEER]: 2 }, 'the caller’s object is not mutated');
  assert.deepEqual(withoutSelfUnread({ [PEER]: 1 }, ''), { [PEER]: 1 });
});

test('a message from the wallet to itself is never a badge', () => {
  const messages = [
    { from: OWNER, to: OWNER, receivedAt: 100 },
    { from: PEER, to: OWNER, receivedAt: 150 },
  ];
  // Even a rebuild from the whole mailbox, and even with a stale stored count.
  const rebuilt = countNewMessages({
    messages, marks: {}, owner: OWNER, previous: { [OWNER]: 4 }, reset: true,
  });
  assert.deepEqual(rebuilt.counts, { [PEER]: 1 });
  assert.equal(rebuilt.newest[OWNER], undefined, 'nothing to mark read for the saved room');

  // The same batch without an owner still skips the self-addressed line, because
  // sender and recipient are compared directly.
  assert.deepEqual(countNewMessages({ messages, marks: {}, reset: true }).counts, { [PEER]: 1 });
});

test('opening Saved Messages leaves no badge behind', () => {
  const { counts } = countNewMessages({
    messages: [{ from: OWNER, to: OWNER, receivedAt: 100 }],
    marks: {},
    openPeer: OWNER,
    owner: OWNER,
    previous: { [OWNER]: 2, [PEER]: 1 },
    reset: true,
  });
  assert.deepEqual(counts, {});
});

test('a stored snapshot cannot keep an old self count alive', () => {
  const storage = memoryStorage({
    [UNREAD_KEY]: JSON.stringify({
      [OWNER]: { at: 10, counts: { [OWNER]: 2, [PEER]: 1 } },
    }),
  });
  assert.deepEqual(readUnreadSnapshot(OWNER, storage), { at: 10, counts: { [PEER]: 1 } });

  const written = writeUnreadSnapshot(OWNER, {
    at: 20, counts: { [OWNER]: 3, [PEER]: 2 },
  }, storage);
  assert.deepEqual(written, { at: 20, counts: { [PEER]: 2 } });
  const raw = JSON.parse(storage.getItem(UNREAD_KEY))[OWNER];
  assert.deepEqual(Object.keys(raw.counts), [PEER], 'the self count is never persisted');
});

test('the locked-wallet list does not add up a saved room from either wallet', () => {
  const storage = memoryStorage();
  writeUnreadSnapshot(OWNER, { at: 10, counts: { [OWNER]: 2, [PEER]: 1 } }, storage);
  writeUnreadSnapshot(OTHER_OWNER, { at: 20, counts: { [OTHER_OWNER]: 5, [PEER]: 4 } }, storage);

  const merged = mergeUnreadSnapshots([OWNER, OTHER_OWNER], storage);
  assert.deepEqual(merged.counts, { [PEER]: 5 });
  assert.equal(merged.at, 20);
});
