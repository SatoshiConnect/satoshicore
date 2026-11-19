import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_OUTBOX, enqueueOutbox, markOutboxFailure, outboxKey, readOutbox, removeOutbox,
} from '../lib/chatOutbox.js';

const OWNER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const PEER = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const item = (id, overrides = {}) => ({
  clientId: `client-${id}-0001`,
  to: PEER,
  envelope: { v: 1, from: OWNER, to: PEER, box: `cipher-${id}` },
  createdAt: 1_760_000_000_000 + id,
  ...overrides,
});

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
}

test('a queued envelope is ciphertext only and survives a reload', () => {
  const storage = memoryStorage();
  enqueueOutbox(OWNER, item(1), storage);
  const rows = readOutbox(OWNER, storage);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].clientId, 'client-1-0001');
  assert.equal(rows[0].envelope.box, 'cipher-1');
  assert.equal(JSON.stringify(rows).includes('hello'), false);
  assert.equal(outboxKey(OWNER).endsWith(OWNER), true);
});

test('the same client id is queued once, so a retry cannot duplicate it', () => {
  const storage = memoryStorage();
  enqueueOutbox(OWNER, item(1), storage);
  enqueueOutbox(OWNER, item(1, { envelope: { box: 'different' } }), storage);
  assert.equal(readOutbox(OWNER, storage).length, 1);
  assert.equal(readOutbox(OWNER, storage)[0].envelope.box, 'cipher-1');
});

test('queues are scoped per wallet and the oldest entries are capped', () => {
  const storage = memoryStorage();
  for (let i = 1; i <= MAX_OUTBOX + 3; i += 1) enqueueOutbox(OWNER, item(i), storage);
  const rows = readOutbox(OWNER, storage);
  assert.equal(rows.length, MAX_OUTBOX);
  assert.equal(rows[0].clientId, `client-4-0001`);
  assert.equal(readOutbox('GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', storage).length, 0);
});

test('removing an entry leaves the rest untouched', () => {
  const storage = memoryStorage();
  enqueueOutbox(OWNER, item(1), storage);
  enqueueOutbox(OWNER, item(2), storage);
  removeOutbox(OWNER, 'client-1-0001', storage);
  assert.deepEqual(readOutbox(OWNER, storage).map((row) => row.clientId), ['client-2-0001']);
});

test('a failure records an attempt and a bounded reason without changing bytes', () => {
  const storage = memoryStorage();
  enqueueOutbox(OWNER, item(1), storage);
  const rows = markOutboxFailure(OWNER, 'client-1-0001', new Error('x'.repeat(400)), storage);
  assert.equal(rows[0].attempts, 1);
  assert.equal(rows[0].lastError.length, 240);
  assert.equal(rows[0].envelope.box, 'cipher-1');
});

test('corrupt or foreign rows are ignored, not trusted', () => {
  const storage = memoryStorage();
  storage.setItem(outboxKey(OWNER), JSON.stringify([
    { clientId: 'short', to: PEER, envelope: {}, createdAt: 1 },
    { clientId: 'client-valid-1', to: 'not-an-address', envelope: {}, createdAt: 1 },
    item(1),
  ]));
  assert.equal(readOutbox(OWNER, storage).length, 1);
  storage.setItem(outboxKey(OWNER), '{broken');
  assert.deepEqual(readOutbox(OWNER, storage), []);
});
