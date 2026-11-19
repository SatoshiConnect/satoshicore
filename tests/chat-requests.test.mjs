// Message requests are a gate, not a transport: the same ciphertext stays on
// the relay, but a stranger's mail is not counted, not previewed and not
// acknowledged until the person accepts, blocks or deletes it. These tests pin
// who counts as a stranger and what the store keeps (addresses only).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  REQUEST_LIMIT, REQUESTS_PREFIX, acceptSender, dropPending, isRequestSender,
  notePending, readRequests, withoutRequestCounts,
} from '../lib/chatRequests.js';
import { countNewMessages } from '../lib/chatUnread.js';

const OWNER = `G${'A'.repeat(55)}`;
const STRANGER = `G${'C'.repeat(55)}`;
const CONTACT = `G${'D'.repeat(55)}`;
const FRIEND = `G${'E'.repeat(55)}`;
const ACCEPTED = `G${'F'.repeat(55)}`;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const addressAt = (i) => `G${B32[Math.floor(i / 32) % 32]}${B32[i % 32]}${'A'.repeat(53)}`;

const memoryStorage = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    raw: () => map,
  };
};

test('an unknown sender is a request; everybody this device knows is not', () => {
  const base = { owner: OWNER };
  assert.equal(isRequestSender(STRANGER, base), true);
  assert.equal(isRequestSender(STRANGER.toLowerCase(), base), true, 'a pasted address still matches');

  assert.equal(isRequestSender(OWNER, base), false, 'Saved Messages is never a request');
  assert.equal(isRequestSender(OWNER.toLowerCase(), base), false);
  assert.equal(isRequestSender(STRANGER, { owner: OWNER, contacts: [CONTACT, STRANGER] }), false);
  assert.equal(isRequestSender(STRANGER, { owner: OWNER, friends: [STRANGER] }), false);
  assert.equal(isRequestSender(STRANGER, { owner: OWNER, accepted: [STRANGER] }), false);
  assert.equal(isRequestSender(STRANGER, { owner: OWNER, archived: new Set([STRANGER]) }), false,
    'a peer this device already has history with is a conversation, not a stranger');

  assert.equal(isRequestSender('', base), false);
  assert.equal(isRequestSender('Gshort', base), false);
  assert.equal(isRequestSender(STRANGER, {}), true);
});

test('the store keeps addresses per wallet and remembers who is waiting', () => {
  const storage = memoryStorage();
  assert.deepEqual(readRequests(storage, OWNER), { accepted: [], pending: [] });

  const first = notePending(storage, OWNER, [STRANGER]);
  assert.deepEqual(first.pending, [STRANGER]);
  assert.equal(first.changed, true);

  const again = notePending(storage, OWNER, [STRANGER.toLowerCase(), 'not-an-address']);
  assert.deepEqual(again.pending, [STRANGER], 'no duplicates, no junk');
  assert.equal(again.changed, false, 'a repeat poll does not rewrite the store');

  assert.deepEqual(readRequests(storage, OWNER).pending, [STRANGER]);
  assert.deepEqual(readRequests(storage, `G${'B'.repeat(55)}`), { accepted: [], pending: [] },
    'another wallet has its own list');

  const stored = JSON.parse(storage.getItem(`${REQUESTS_PREFIX}${OWNER}`));
  assert.deepEqual(stored, { accepted: [], pending: [STRANGER] }, 'only addresses are stored');
});

test('accepting moves a sender out of the request list and keeps them there', () => {
  const storage = memoryStorage();
  notePending(storage, OWNER, [STRANGER, CONTACT]);

  const accepted = acceptSender(storage, OWNER, STRANGER);
  assert.deepEqual(accepted.pending, [CONTACT]);
  assert.deepEqual(accepted.accepted, [STRANGER]);
  assert.equal(accepted.changed, true);

  assert.deepEqual(readRequests(storage, OWNER), { accepted: [STRANGER], pending: [CONTACT] });
  assert.equal(isRequestSender(STRANGER, { owner: OWNER, accepted: accepted.accepted }), false,
    'an accepted sender writes normally from then on');

  const twice = acceptSender(storage, OWNER, STRANGER);
  assert.equal(twice.changed, false, 'accepting twice changes nothing');

  const direct = acceptSender(storage, OWNER, FRIEND);
  assert.deepEqual(direct.accepted, [STRANGER, FRIEND], 'accepting an unlisted sender still works');
  assert.deepEqual(direct.pending, [CONTACT]);
});

test('delete and block forget one request without touching the others', () => {
  const storage = memoryStorage();
  notePending(storage, OWNER, [STRANGER, CONTACT, FRIEND]);

  const dropped = dropPending(storage, OWNER, CONTACT);
  assert.deepEqual(dropped.pending, [STRANGER, FRIEND]);
  assert.deepEqual(dropped.accepted, []);
  assert.equal(dropped.changed, true);

  assert.equal(dropPending(storage, OWNER, CONTACT).changed, false, 'dropping twice is a no-op');
  assert.deepEqual(readRequests(storage, OWNER).pending, [STRANGER, FRIEND]);
});

test('a corrupt or oversized store never throws and stays bounded', () => {
  const corrupt = memoryStorage({ [`${REQUESTS_PREFIX}${OWNER}`]: '{not json' });
  assert.deepEqual(readRequests(corrupt, OWNER), { accepted: [], pending: [] });
  assert.deepEqual(readRequests(memoryStorage({ [`${REQUESTS_PREFIX}${OWNER}`]: '{"pending":"nope"}' }), OWNER),
    { accepted: [], pending: [] });

  const many = Array.from({ length: REQUEST_LIMIT + 20 }, (_, i) => addressAt(i));
  const storage = memoryStorage();
  const noted = notePending(storage, OWNER, many);
  assert.equal(noted.pending.length, REQUEST_LIMIT, 'the list is capped');
});

test('badges of a request sender are dropped from the snapshot view', () => {
  const counts = { [STRANGER]: 3, [CONTACT]: 1 };
  const next = withoutRequestCounts(counts, (peer) => isRequestSender(peer, {
    owner: OWNER, contacts: [CONTACT],
  }));
  assert.deepEqual(next, { [CONTACT]: 1 });
  assert.deepEqual(counts, { [STRANGER]: 3, [CONTACT]: 1 }, 'the input is not mutated');
  assert.deepEqual(withoutRequestCounts(null, () => true), {});
});

test('the chat screen gates before counting and offers the three actions', () => {
  const source = readFileSync(new URL('../components/ChatPanel.js', import.meta.url), 'utf8');
  assert.match(source, /isRequestSender/);
  assert.match(source, /isRequestRef\.current\(from\)/, 'the poll decides before it counts');
  assert.match(source, /rememberPendingRequests\(\[\.\.\.waiting\]\)/);
  assert.match(source, /withoutRequestCounts\(\s*readUnreadSnapshot/, 'a stored badge is dropped too');
  assert.match(source, /aria-label="Message requests"/);
  assert.match(source, /acceptRequest\(sender\)/);
  assert.match(source, /blockRequest\(sender\)/);
  assert.match(source, /deleteRequest\(sender\)/);
});

test('a stranger’s message is never counted, a contact’s is', () => {
  const messages = [
    { from: STRANGER, to: OWNER, receivedAt: 100 },
    { from: CONTACT, to: OWNER, receivedAt: 200 },
  ];
  const isRequest = (peer) => isRequestSender(peer, { owner: OWNER, contacts: [CONTACT] });
  const counted = messages.filter((message) => !isRequest(message.from));
  assert.deepEqual(counted.map((message) => message.from), [CONTACT]);

  const { counts } = countNewMessages({
    messages: counted,
    marks: {},
    owner: OWNER,
    previous: withoutRequestCounts({ [STRANGER]: 5 }, isRequest),
    reset: true,
  });
  assert.deepEqual(counts, { [CONTACT]: 1 }, 'no badge for the stranger, and a stale one is cleared');
});
