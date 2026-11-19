import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  archiveMessages, deriveArchiveKey, forgetArchiveKeys, migrateArchiveData, openArchiveText,
  readArchivedRows,
} from '../lib/chatArchive.js';
import { FakeIndexedDB } from './helpers/fakeIndexedDb.mjs';

const OWN = `G${'A'.repeat(55)}`;
const PEER = `G${'B'.repeat(55)}`;
const WALLET_SEED = new Uint8Array(32).fill(7);
const CHAT_SEED = new Uint8Array(32).fill(9);

afterEach(() => {
  delete globalThis.indexedDB;
  forgetArchiveKeys();
});

test('old transcript rows migrate to the chat identity and remain readable', async () => {
  globalThis.indexedDB = new FakeIndexedDB();
  await archiveMessages({
    seed32: WALLET_SEED,
    address: OWN,
    peer: PEER,
    messages: [{ id: 'm1', from: PEER, text: 'old history', at: 1_000, own: false }],
  });
  const oldRows = await readArchivedRows(OWN);
  assert.equal(oldRows.length, 1);
  assert.equal((await openArchiveText(await deriveArchiveKey(WALLET_SEED, OWN), {
    ...oldRows[0], address: OWN,
  })).text, 'old history');

  const result = await migrateArchiveData({
    fromSeed32: WALLET_SEED, toSeed32: CHAT_SEED, address: OWN,
  });
  assert.deepEqual(result, { migrated: 1, skipped: 0 });
  const migratedRows = await readArchivedRows(OWN);
  assert.equal(migratedRows.length, 1);
  const chatKey = await deriveArchiveKey(CHAT_SEED, OWN, 'chat');
  assert.equal((await openArchiveText(chatKey, { ...migratedRows[0], address: OWN })).text, 'old history');
  assert.equal(await openArchiveText(
    await deriveArchiveKey(WALLET_SEED, OWN), { ...migratedRows[0], address: OWN },
  ), null);

  // Running it again is a no-op: the row is already under the new key.
  assert.deepEqual(await migrateArchiveData({
    fromSeed32: WALLET_SEED, toSeed32: CHAT_SEED, address: OWN,
  }), { migrated: 0, skipped: 1 });
});