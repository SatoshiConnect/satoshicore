// Keep is a three-step promise: the archive write, the Saved Messages copy, and
// only then the ack. These tests pin the order and the "never acknowledge what
// was not stored" rule, plus the relay countdown the room shows.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  RELAY_RETENTION_MS, archiveIdOf, expiryLabel, keepMessage, keptIds, relayExpiresAt,
} from '../lib/chatKeep.js';

const OWNER = `G${'A'.repeat(55)}`;
const PEER = `G${'C'.repeat(55)}`;

const message = (over = {}) => ({
  id: `m${7}`, peer: PEER, from: PEER, text: 'keep me', at: 1_000, receivedAt: 1_100, own: false, ...over,
});

test('a kept line is stored in its room, copied to Saved Messages, then acked', async () => {
  const calls = [];
  const archive = async ({ peer, messages }) => {
    calls.push({ peer, message: messages[0] });
    return 1;
  };
  const acked = [];
  const ack = async (id) => { acked.push(id); return 1; };

  const result = await keepMessage({
    message: message(), address: OWNER, seed32: new Uint8Array(32), archive, ack, relayId: 7,
  });

  assert.deepEqual(calls.map((call) => call.peer), [PEER, OWNER]);
  assert.deepEqual(calls[0].message, {
    id: 'm7', at: 1_000, text: 'keep me', own: false,
  });
  assert.deepEqual(calls[1].message, {
    id: 'm7', at: 1_000, text: 'keep me', own: true,
  }, 'the copy belongs to this wallet, so it reads as own in Saved Messages');
  assert.deepEqual(acked, [7], 'the relay copy goes only after both writes');
  assert.deepEqual(result, { stored: 1, saved: 1, acked: 1, id: 'm7' });
});

test('a failed source write acknowledges nothing', async () => {
  const acked = [];
  await assert.rejects(keepMessage({
    message: message(),
    address: OWNER,
    archive: async () => 0,
    ack: async (id) => { acked.push(id); return 1; },
    relayId: 7,
  }), /could not store/);
  assert.deepEqual(acked, []);
});

test('a failed Saved Messages copy acknowledges nothing', async () => {
  const acked = [];
  let calls = 0;
  await assert.rejects(keepMessage({
    message: message(),
    address: OWNER,
    archive: async () => { calls += 1; return calls === 1 ? 1 : 0; },
    ack: async (id) => { acked.push(id); return 1; },
    relayId: 7,
  }), /Saved Messages copy/);
  assert.equal(calls, 2);
  assert.deepEqual(acked, [], 'the relay copy stays when the copy is missing');
});

test('keeping a line in Saved Messages writes one row and no copy', async () => {
  const peers = [];
  const result = await keepMessage({
    message: message({ id: 'm9', peer: OWNER, from: OWNER, own: true }),
    address: OWNER,
    archive: async ({ peer }) => { peers.push(peer); return 1; },
    ack: async () => 1,
    relayId: 9,
  });
  assert.deepEqual(peers, [OWNER]);
  assert.equal(result.saved, 0);
  assert.equal(result.acked, 1);
});

test('a line that is not on the relay is kept without an ack', async () => {
  const acked = [];
  const result = await keepMessage({
    message: message({ id: 'client-1', receivedAt: 0 }),
    address: OWNER,
    archive: async () => 1,
    ack: async (id) => { acked.push(id); return 1; },
  });
  assert.deepEqual(acked, []);
  assert.equal(result.id, 'client-1');
});

test('the archive id is one shape whichever screen saved the line', async () => {
  assert.equal(archiveIdOf({ id: 'm42' }), 'm42');
  assert.equal(archiveIdOf({ id: 42 }), 'm42', 'a locally sent id becomes the relay shape');
  assert.equal(archiveIdOf({ id: 'client-1' }), 'client-1');

  const ids = [];
  await keepMessage({
    message: message({ id: 42 }),
    address: OWNER,
    archive: async ({ messages }) => { ids.push(messages[0].id); return 1; },
    ack: async () => 1,
    relayId: 42,
  });
  assert.deepEqual(ids, ['m42', 'm42']);
});

test('the countdown follows the relay’s arrival clock, not the sender’s', () => {
  const arrived = 1_000_000;
  const local = message({ id: 'client-1', receivedAt: 0 });
  assert.equal(relayExpiresAt(local), 0, 'a line never on the relay has no expiry');
  assert.equal(expiryLabel(local), '');

  const row = message({ receivedAt: arrived, at: arrived - 5_000 });
  assert.equal(relayExpiresAt(row), arrived + RELAY_RETENTION_MS);
  assert.equal(expiryLabel(row, arrived), 'expires in 7d');
  assert.equal(expiryLabel(row, arrived + 6 * 86_400_000), 'expires in 1d');
  assert.equal(expiryLabel(row, arrived + RELAY_RETENTION_MS - 3_600_000), 'expires in 1h');
  assert.equal(expiryLabel(row, arrived + RELAY_RETENTION_MS - 60_000), 'expires in 1m');
  assert.equal(expiryLabel(row, arrived + RELAY_RETENTION_MS), 'relay copy expired');
});

test('kept ids separate "this device has it" from "Saved Messages has it"', () => {
  const rows = [
    { id: 'm1', peer: PEER },
    { id: 'm2', peer: OWNER },
    { id: 'm3', peer: OWNER.toLowerCase() },
    { id: '', peer: PEER },
    {},
  ];
  const { anywhere, inSaved } = keptIds(rows, OWNER);
  assert.deepEqual([...anywhere].sort(), ['m1', 'm2', 'm3']);
  assert.deepEqual([...inSaved].sort(), ['m2', 'm3']);
  assert.deepEqual(keptIds([], OWNER).anywhere.size, 0);
  assert.deepEqual(keptIds(null, OWNER).inSaved.size, 0);
});
