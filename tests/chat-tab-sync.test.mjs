// Deterministic coverage for the tab-level chat coordinator.
//
// The fake lock queue and fake BroadcastChannel stand in for the browser APIs,
// so the tests never depend on real tabs or timing. They exercise one reader per
// wallet, handoff when that tab closes, snapshot replay for a new tab, and the
// locked-tab rule that a wallet without a seed never becomes the poller.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { createChatTabSync } from '../lib/chatTabSync.js';

const WALLET = `G${'A'.repeat(55)}`;
const OTHER_WALLET = `G${'B'.repeat(55)}`;
const PEER = `G${'C'.repeat(55)}`;

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

class FakeLocks {
  constructor() {
    this.held = new Set();
    this.queues = new Map();
  }

  request(name, callback) {
    return new Promise((resolve, reject) => {
      const queue = this.queues.get(name) || [];
      queue.push({ callback, resolve, reject });
      this.queues.set(name, queue);
      this.drain(name);
    });
  }

  async drain(name) {
    if (this.held.has(name)) return;
    const queue = this.queues.get(name) || [];
    const next = queue.shift();
    if (!next) return;
    this.held.add(name);
    try {
      await next.callback();
      next.resolve();
    } catch (error) {
      next.reject(error);
    } finally {
      this.held.delete(name);
      this.drain(name);
    }
  }
}

class FakeBroadcastChannel {
  static rooms = new Map();

  constructor(name) {
    this.name = name;
    this.onmessage = null;
    this.closed = false;
    const room = FakeBroadcastChannel.rooms.get(name) || new Set();
    room.add(this);
    FakeBroadcastChannel.rooms.set(name, room);
  }

  postMessage(message) {
    const payload = JSON.parse(JSON.stringify(message));
    for (const peer of FakeBroadcastChannel.rooms.get(this.name) || []) {
      if (peer === this || peer.closed) continue;
      queueMicrotask(() => {
        if (!peer.closed) peer.onmessage?.({ data: payload });
      });
    }
  }

  close() {
    this.closed = true;
    FakeBroadcastChannel.rooms.get(this.name)?.delete(this);
  }
}

function tab(options = {}) {
  const snapshots = [];
  const changes = [];
  const sync = createChatTabSync({
    wallet: WALLET,
    locks: new FakeLocks(),
    Channel: FakeBroadcastChannel,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onLeaderChange: (leader) => changes.push(leader),
    ...options,
  });
  return { sync, snapshots, changes };
}

test('one tab owns the wallet poll lock and followers receive its snapshot', async () => {
  const locks = new FakeLocks();
  const first = tab({ locks });
  const second = tab({ locks });

  first.sync.start();
  second.sync.start();
  await flush();

  assert.equal(first.sync.isLeader(), true);
  assert.equal(second.sync.isLeader(), false);
  assert.deepEqual(first.changes, [true]);
  assert.deepEqual(second.changes, []);

  first.sync.publish({ at: 100, counts: { [PEER]: 2 } });
  await flush();
  assert.deepEqual(second.snapshots, [{ at: 100, counts: { [PEER]: 2 } }]);

  first.sync.close();
  await flush();
  assert.equal(second.sync.isLeader(), true);
  assert.deepEqual(second.changes, [true]);

  second.sync.close();
});

test('a new tab asks the leader for the last snapshot instead of waiting for a poll', async () => {
  const locks = new FakeLocks();
  const first = tab({ locks });
  first.sync.start();
  await flush();
  first.sync.prime({ at: 42, counts: { [PEER]: 1 } });

  const second = tab({ locks });
  second.sync.start();
  await flush();

  assert.deepEqual(second.snapshots, [{ at: 42, counts: { [PEER]: 1 } }]);
  first.sync.close();
  second.sync.close();
});

test('a locked tab follows snapshots but never queues for the poll lock', async () => {
  const locks = new FakeLocks();
  const leader = tab({ locks });
  const locked = tab({ locks, canLead: false });

  leader.sync.start();
  locked.sync.start();
  await flush();
  assert.equal(leader.sync.isLeader(), true);
  assert.equal(locked.sync.isLeader(), false);

  leader.sync.close();
  await flush();
  assert.equal(locked.sync.isLeader(), false);
  locked.sync.close();
});

test('snapshots are scoped to one wallet channel', async () => {
  const locks = new FakeLocks();
  const first = tab({ locks });
  const other = tab({ locks, wallet: OTHER_WALLET });
  first.sync.start();
  other.sync.start();
  await flush();

  first.sync.publish({ at: 7, counts: { [PEER]: 4 } });
  await flush();
  assert.deepEqual(other.snapshots, []);

  first.sync.close();
  other.sync.close();
});

test('without Web Locks the fallback still polls and broadcasts', async () => {
  const locks = null;
  const first = tab({ locks });
  const second = tab({ locks });
  first.sync.start();
  second.sync.start();
  await flush();

  assert.equal(first.sync.isLeader(), true);
  assert.equal(second.sync.isLeader(), true);
  first.sync.publish({ at: 8, counts: { [PEER]: 1 } });
  await flush();
  assert.deepEqual(second.snapshots, [{ at: 8, counts: { [PEER]: 1 } }]);

  first.sync.close();
  second.sync.close();
});

test('ChatPanel gates its poll timer on the tab leader', () => {
  const source = readFileSync(new URL('../components/ChatPanel.js', import.meta.url), 'utf8');
  assert.match(source, /createChatTabSync\(/);
  assert.match(source, /!pollLeader/);
  assert.match(source, /tabSyncRef\.current\?\.publish\(saved\)/);
});
