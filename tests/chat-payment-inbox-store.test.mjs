import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  ARCHIVE_DB, ARCHIVE_VERSION, REQUESTS_STORE, forgetArchiveKeys, openArchiveDb,
} from '../lib/chatArchive.js';
import {
  REQUEST_TTL_MS, migratePaymentRequests, readPaymentRequests, setPaymentRequestStatus,
  upsertPaymentRequests,
} from '../lib/chatPaymentInbox.js';
import { FakeIndexedDB } from './helpers/fakeIndexedDb.mjs';

const OWN = `G${'A'.repeat(55)}`;
const PEER = `G${'B'.repeat(55)}`;
const SEED = new Uint8Array(32).fill(7);
const CHAT_SEED = new Uint8Array(32).fill(9);

const openForTest = (fake, version = ARCHIVE_VERSION) => new Promise((resolve, reject) => {
  const request = fake.open(ARCHIVE_DB, version);
  request.onupgradeneeded = () => {
    request.result.createObjectStore('messages', { keyPath: 'key' });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const request = (overrides = {}) => ({
  requestKey: 'incoming:1',
  direction: 'incoming',
  peer: PEER,
  to: PEER,
  amount: '125',
  status: 'pending',
  createdAt: 1_000,
  updatedAt: 1_000,
  messageId: '1',
  ...overrides,
});

afterEach(() => {
  delete globalThis.indexedDB;
  forgetArchiveKeys();
});

test('a v1 archive upgrades to v2 and adds the requests store', async () => {
  const fake = new FakeIndexedDB();
  globalThis.indexedDB = fake;

  const old = await openForTest(fake, 1);
  assert.equal(old.version, 1);
  assert.equal(old.objectStoreNames.contains(REQUESTS_STORE), false);
  old.close();

  const db = await openArchiveDb();
  assert.equal(db.version, 2);
  assert.equal(db.objectStoreNames.contains('messages'), true);
  assert.equal(db.objectStoreNames.contains(REQUESTS_STORE), true);

  // The upgraded store is immediately usable by the inbox.
  assert.equal(await upsertPaymentRequests({
    seed32: SEED, address: OWN, requests: [request()], now: 2_000,
  }), 1);
  assert.deepEqual(await readPaymentRequests({
    seed32: SEED, address: OWN, now: 2_000,
  }), [{ ...request() }]);
  db.close();
});

test('requests round-trip through the encrypted store and preserve status updates', async () => {
  const fake = new FakeIndexedDB();
  globalThis.indexedDB = fake;

  assert.equal(await upsertPaymentRequests({
    seed32: SEED,
    address: OWN,
    requests: [request(), request({
      requestKey: 'outgoing:2', direction: 'outgoing', amount: '9', messageId: '2',
    })],
    now: 2_000,
  }), 2);

  const initial = await readPaymentRequests({ seed32: SEED, address: OWN, now: 2_000 });
  assert.equal(initial.length, 2);
  assert.deepEqual(initial.map((item) => item.status), ['pending', 'pending']);

  const paid = await setPaymentRequestStatus({
    seed32: SEED, address: OWN, requestKey: 'incoming:1', status: 'paid', now: 2_100,
  });
  assert.equal(paid.status, 'paid');
  assert.equal(paid.updatedAt, 2_100);

  const after = await readPaymentRequests({ seed32: SEED, address: OWN, now: 2_100 });
  assert.equal(after.find((item) => item.requestKey === 'incoming:1').status, 'paid');
  assert.equal(after.find((item) => item.requestKey === 'outgoing:2').status, 'pending');
});

test('old request rows migrate from the wallet seed to the chat identity scope', async () => {
  const fake = new FakeIndexedDB();
  globalThis.indexedDB = fake;

  await upsertPaymentRequests({
    seed32: SEED, address: OWN, requests: [request()], now: 2_000,
  });
  assert.equal((await readPaymentRequests({ seed32: SEED, address: OWN, now: 2_000 })).length, 1);

  const result = await migratePaymentRequests({
    fromSeed32: SEED, toSeed32: CHAT_SEED, address: OWN,
  });
  assert.equal(result.migrated, 1);
  assert.equal(result.skipped, 0);

  // The inbox now opens with the chat identity alone; the old seed no longer
  // decrypts rows under the new scope.
  const migrated = await readPaymentRequests({
    seed32: CHAT_SEED, address: OWN, now: 2_000, keyScope: 'chat',
  });
  assert.deepEqual(migrated, [{ ...request() }]);
  assert.equal((await readPaymentRequests({
    seed32: SEED, address: OWN, now: 2_000, keyScope: 'chat',
  })).length, 0);
});

test('expiry is materialized once and remains expired on a later read', async () => {
  const fake = new FakeIndexedDB();
  globalThis.indexedDB = fake;

  await upsertPaymentRequests({
    seed32: SEED, address: OWN, requests: [request()], now: 2_000,
  });

  const expiredAt = 1_000 + REQUEST_TTL_MS + 1;
  const first = await readPaymentRequests({ seed32: SEED, address: OWN, now: expiredAt });
  assert.equal(first[0].status, 'expired');
  assert.equal(first[0].updatedAt, expiredAt);

  // The stored row changed, not just the returned projection.
  const again = await readPaymentRequests({ seed32: SEED, address: OWN, now: 1_000 });
  assert.equal(again[0].status, 'expired');
});

test('expiry materialization leaves an already-paid row alone', async () => {
  const fake = new FakeIndexedDB();
  globalThis.indexedDB = fake;

  await upsertPaymentRequests({
    seed32: SEED, address: OWN, requests: [request()], now: 2_000,
  });
  await setPaymentRequestStatus({
    seed32: SEED, address: OWN, requestKey: 'incoming:1', status: 'paid', now: 2_100,
  });

  const expiredAt = 1_000 + REQUEST_TTL_MS + 1;
  const read = await readPaymentRequests({ seed32: SEED, address: OWN, now: expiredAt });
  assert.equal(read[0].status, 'paid');
});

for (const status of ['paid', 'declined']) {
  test(`a stale expiry write cannot overwrite ${status}`, async () => {
    const fake = new FakeIndexedDB();
    globalThis.indexedDB = fake;

    await upsertPaymentRequests({
      seed32: SEED, address: OWN, requests: [request()], now: 2_000,
    });

    const gate = fake.holdNextRequestWrite();
    const expiring = readPaymentRequests({
      seed32: SEED, address: OWN, now: 1_000 + REQUEST_TTL_MS + 1,
    });
    await gate.started;

    const updated = await setPaymentRequestStatus({
      seed32: SEED, address: OWN, requestKey: 'incoming:1', status, now: 2_100,
    });
    assert.equal(updated.status, status);

    gate.release();
    const raced = await expiring;

    // The compare-and-set must skip the stale expired row, and the queued read
    // must return the winner rather than a stale expired projection.
    assert.equal(raced.find((item) => item.requestKey === 'incoming:1').status, status);
    const stored = await readPaymentRequests({ seed32: SEED, address: OWN, now: 2_100 });
    assert.equal(stored.find((item) => item.requestKey === 'incoming:1').status, status);
  });
}
