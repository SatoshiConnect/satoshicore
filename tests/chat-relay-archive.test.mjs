// The poll path may free a relay copy only after the archive has stored it.
// These tests hold the archive write open, fail it, and fail it per peer, so a
// regression that acknowledges first shows up here instead of as lost mail.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readArchivePrefs, writeArchivePrefs } from '../lib/chatArchive.js';
import {
  ackIds, archiveAndClearRelay, relayIdOf,
} from '../lib/chatRelayArchive.js';

const ADDRESS = `G${'A'.repeat(55)}`;
const PEER = `G${'C'.repeat(55)}`;
const OTHER = `G${'D'.repeat(55)}`;
const SEED = new Uint8Array(32).fill(7);
const TS = 1_794_800_000_000;

const memoryStorage = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
};

// A relay row as the poll fetches it: numeric id, authenticated sender, `ts`.
const relayRow = (id, overrides = {}) => ({
  id: String(id), from: PEER, text: `relay ${id}`, ts: TS + id, receivedAt: TS + id + 5,
  ...overrides,
});

const enabled = { enabled: true, wipeOnLock: false };

test('poll stores every peer group, then acknowledges all stored ids in one call', async () => {
  const events = [];
  const rows = [relayRow(41), relayRow(42, { from: OTHER })];

  const result = await archiveAndClearRelay({
    seed32: SEED,
    address: ADDRESS,
    messages: rows,
    prefs: enabled,
    store: async ({ address, peer, messages }) => {
      events.push(['store', address, peer, messages]);
      return messages.length;
    },
    ack: async ({ seed32, address, ids }) => {
      events.push(['ack', seed32, address, ids]);
      return ids.length;
    },
  });

  assert.equal(result, 2);
  assert.deepEqual(events.map(([kind]) => kind), ['store', 'store', 'ack']);
  // The archive gets the relay shape with one id format and `ts` as `at`.
  assert.deepEqual(events[0], ['store', ADDRESS, PEER, [{
    id: 'm41', from: PEER, text: 'relay 41', ts: TS + 41, receivedAt: TS + 46, at: TS + 41,
  }]]);
  assert.deepEqual(events[1][2], OTHER);
  // Nothing is acknowledged until both writes have resolved, and the ids keep
  // the archive's `m` prefix stripped back to the relay id.
  assert.deepEqual(events[2], ['ack', SEED, ADDRESS, [41, 42]]);
});

test('nothing is acknowledged while the archive write is still pending', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let began;
  const started = new Promise((resolve) => { began = resolve; });
  let acked = 0;

  const writing = archiveAndClearRelay({
    seed32: SEED,
    address: ADDRESS,
    messages: [relayRow(5)],
    prefs: enabled,
    store: async ({ messages }) => { began(); await gate; return messages.length; },
    ack: async () => { acked += 1; return 1; },
  });

  await started;
  // A non-awaited ack would already have run by this microtask turn.
  await Promise.resolve();
  assert.equal(acked, 0, 'ack must wait for the archive write to resolve');
  release();
  assert.equal(await writing, 1);
  assert.equal(acked, 1);
});

test('a failed archive write leaves the message on the relay', async () => {
  let acked = 0;
  const result = await archiveAndClearRelay({
    seed32: SEED,
    address: ADDRESS,
    messages: [relayRow(7)],
    prefs: enabled,
    store: async () => { throw new Error('quota exceeded'); },
    ack: async () => { acked += 1; return 1; },
  });

  assert.equal(result, 0);
  assert.equal(acked, 0, 'the relay copy must survive an archive failure');
});

test('an unavailable archive (nothing stored) is not acknowledged either', async () => {
  let acked = 0;
  const result = await archiveAndClearRelay({
    seed32: SEED,
    address: ADDRESS,
    messages: [relayRow(8)],
    prefs: enabled,
    store: async () => 0,
    ack: async () => { acked += 1; return 1; },
  });

  assert.equal(result, 0);
  assert.equal(acked, 0);
});

test('a peer whose write failed is not acknowledged while the other peer is', async () => {
  const acked = [];
  const result = await archiveAndClearRelay({
    seed32: SEED,
    address: ADDRESS,
    messages: [relayRow(11), relayRow(12, { from: OTHER })],
    prefs: enabled,
    store: async ({ peer, messages }) => {
      if (peer === PEER) throw new Error('disk full');
      return messages.length;
    },
    ack: async ({ ids }) => { acked.push(...ids); return ids.length; },
  });

  assert.equal(result, 1);
  assert.deepEqual(acked, [12]);
});

test('saving off means neither the archive nor the relay is touched', async () => {
  const storage = memoryStorage();
  writeArchivePrefs({ enabled: false }, storage);
  let stored = 0;
  let acked = 0;

  const result = await archiveAndClearRelay({
    seed32: SEED,
    address: ADDRESS,
    messages: [relayRow(21)],
    prefs: readArchivePrefs(storage),
    store: async () => { stored += 1; return 1; },
    ack: async () => { acked += 1; return 1; },
  });

  assert.equal(result, 0);
  assert.equal(stored, 0);
  assert.equal(acked, 0);
});

test('rows that cannot be archived are skipped, not acknowledged', async () => {
  const stored = [];
  const acked = [];
  const result = await archiveAndClearRelay({
    seed32: SEED,
    address: ADDRESS,
    messages: [
      relayRow('not-an-id'),
      relayRow(31, { text: '' }),
      relayRow(32, { from: '' }),
      relayRow(33),
    ],
    prefs: enabled,
    store: async ({ peer, messages }) => {
      stored.push(...messages.map((message) => message.id));
      return messages.length;
    },
    ack: async ({ ids }) => { acked.push(...ids); return ids.length; },
  });

  assert.deepEqual(stored, ['m33']);
  assert.deepEqual(acked, [33]);
  assert.equal(result, 1);
});

test('an ack failure is swallowed after a successful store', async () => {
  const result = await archiveAndClearRelay({
    seed32: SEED,
    address: ADDRESS,
    messages: [relayRow(51)],
    prefs: enabled,
    store: async () => 1,
    ack: async () => { throw new Error('relay offline'); },
  });

  assert.equal(result, 0);
});

test('ackIds sends only positive integer ids and handles a missing ack', async () => {
  const sent = [];
  assert.equal(await ackIds({ seed32: SEED, address: ADDRESS, ids: [5], ack: undefined }), 0);
  assert.equal(await ackIds({
    seed32: SEED, address: ADDRESS, ids: [5, 6],
    ack: async ({ ids }) => { sent.push(...ids); return ids.length; },
  }), 2);
  assert.deepEqual(sent, [5, 6]);
  assert.equal(await ackIds({ seed32: SEED, address: ADDRESS, ids: [5] }), 0);
});

test('relay and saved ids normalize to the same numeric id', () => {
  assert.equal(relayIdOf({ id: 61 }), 61);
  assert.equal(relayIdOf({ id: 'm61' }), 61);
  assert.equal(relayIdOf({ id: '61' }), 61);
  assert.equal(Number.isSafeInteger(relayIdOf({ id: 'x' })), false);
});
