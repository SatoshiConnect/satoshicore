// Deterministic races around the chat room's async reads.
//
// The fake relay never uses a socket or a real timer. A deferred `peek` lets a
// test choose the completion order, and node:test's fake interval drives the
// 15-second poll without waiting. The guard and ack queue are the production
// modules used by ChatPanel, so removing the checks in the component is also
// caught by the source wiring test at the end.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, mock, test } from 'node:test';

import { createAckQueue, createRoomGuard } from '../lib/chatRoomGuards.js';

const flush = async () => {
  // Enough turns for a resolved peek to reach its guarded ack queue.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class FakeRelay {
  constructor() {
    this.pending = [];
    this.acks = [];
  }

  peek(request) {
    const call = { request, ...deferred(), taken: false };
    this.pending.push(call);
    return call.promise;
  }

  take(kind) {
    const call = this.pending.find((item) => !item.taken && item.request.kind === kind);
    assert.ok(call, `no pending ${kind} request`);
    call.taken = true;
    return call;
  }

  async ack({ ids }) {
    this.acks.push([...ids]);
    return ids.length;
  }
}

// Mirrors the ordering in ChatPanel: guard the peek result, serialize acks, and
// re-check immediately before the side effect. It is deliberately small so the
// race, not unrelated UI, is what the test exercises.
function createSession(relay) {
  const guard = createRoomGuard();
  const ackQueue = createAckQueue();
  const state = { room: '', thread: [], applied: [], ackIds: [] };
  let timer = null;
  let lastPolls = [];

  async function ackOnce(ids, allowed) {
    return ackQueue.run(() => {
      if (!allowed()) return 0;
      const list = ids.filter((id) => Number.isSafeInteger(id) && id > 0);
      if (list.length === 0) return 0;
      state.ackIds.push(...list);
      return relay.ack({ ids: list });
    });
  }

  async function poll(openPeer) {
    const token = guard.beginPoll();
    const messages = await relay.peek({ kind: 'poll', openPeer });
    if (!guard.isCurrentPoll(token)) return 'stale';
    const fresh = openPeer ? messages.filter((message) => message.from === openPeer) : [];
    await ackOnce(fresh.map((message) => message.id), () => guard.isCurrentPoll(token));
    if (!guard.isCurrentPoll(token)) return 'stale';
    state.thread.push(...fresh);
    state.applied.push({ kind: 'poll', openPeer });
    return 'applied';
  }

  async function open(target) {
    const token = guard.beginRoomRead();
    state.room = target;
    const messages = await relay.peek({ kind: 'open', peer: target });
    if (state.room !== target || !guard.isCurrentRoomRead(token)) return 'stale';
    await ackOnce(messages.map((message) => message.id), () => (
      state.room === target && guard.isCurrentRoomRead(token)
    ));
    if (state.room !== target || !guard.isCurrentRoomRead(token)) return 'stale';
    state.thread = messages;
    state.applied.push({ kind: 'open', room: target });
    return 'applied';
  }

  function leave() {
    guard.leaveRoom();
    state.room = '';
    state.thread = [];
  }

  function startPolling(openPeer) {
    stopPolling();
    lastPolls = [];
    timer = setInterval(() => { lastPolls.push(poll(openPeer)); }, 15000);
  }

  function stopPolling() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    state, guard, ackQueue, poll, open, leave, startPolling, stopPolling,
    get lastPolls() { return lastPolls; },
  };
}

afterEach(() => {
  try { mock.timers.reset(); } catch { /* timers were not enabled */ }
});

test('switching rooms during a poll drops its thread state and acknowledgement', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const relay = new FakeRelay();
  const session = createSession(relay);
  session.startPolling('A');

  mock.timers.tick(15000);
  const call = relay.take('poll');
  session.leave();
  call.resolve([{ id: 1, from: 'A', ts: 1, text: 'old room' }]);
  await session.lastPolls[0];

  assert.deepEqual(session.state.applied, []);
  assert.deepEqual(session.state.ackIds, []);
  assert.deepEqual(relay.acks, []);
  session.stopPolling();
});

test('opening a room during a poll invalidates the poll, never the room read', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const relay = new FakeRelay();
  const session = createSession(relay);
  session.startPolling('A');
  mock.timers.tick(15000);
  const pollCall = relay.take('poll');

  const opening = session.open('A');
  const openCall = relay.take('open');
  openCall.resolve([{ id: 2, from: 'A', ts: 2, text: 'opened' }]);
  assert.equal(await opening, 'applied');

  pollCall.resolve([{ id: 1, from: 'A', ts: 1, text: 'poll raced' }]);
  assert.equal(await session.lastPolls[0], 'stale');
  assert.deepEqual(session.state.applied, [{ kind: 'open', room: 'A' }]);
  assert.deepEqual(relay.acks, [[2]]);
  session.stopPolling();
});

test('opening another room during an in-flight read leaves the first read unapplied', async () => {
  const relay = new FakeRelay();
  const session = createSession(relay);
  const first = session.open('A');
  const firstCall = relay.take('open');
  const second = session.open('B');
  const secondCall = relay.take('open');

  firstCall.resolve([{ id: 1, from: 'A', ts: 1, text: 'room A' }]);
  assert.equal(await first, 'stale');
  secondCall.resolve([{ id: 2, from: 'B', ts: 2, text: 'room B' }]);
  assert.equal(await second, 'applied');

  assert.deepEqual(session.state.thread.map((message) => message.text), ['room B']);
  assert.deepEqual(session.state.applied, [{ kind: 'open', room: 'B' }]);
  assert.deepEqual(relay.acks, [[2]]);
});

test('overlapping acknowledgements serialize and a queued stale ack is skipped', async () => {
  const relay = new FakeRelay();
  const session = createSession(relay);
  const gate = deferred();
  const order = [];

  const first = session.ackQueue.run(async () => {
    order.push('first:start');
    await gate.promise;
    order.push('first:end');
    return relay.ack({ ids: [1] });
  });
  const polling = session.poll('A');
  const call = relay.take('poll');
  call.resolve([{ id: 2, from: 'A', ts: 2, text: 'fetched before switch' }]);
  await flush();

  // The poll has queued its ack behind `first`; leaving now makes that task stale.
  session.leave();
  gate.resolve();
  await first;
  assert.equal(await polling, 'stale');

  assert.deepEqual(order, ['first:start', 'first:end']);
  assert.deepEqual(relay.acks, [[1]]);
  assert.deepEqual(session.state.ackIds, []);
});

test('a newer poll invalidates an older poll under the fake poll timer', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const relay = new FakeRelay();
  const session = createSession(relay);
  session.startPolling('A');
  mock.timers.tick(15000);
  mock.timers.tick(15000);

  const older = relay.take('poll');
  const newer = relay.take('poll');
  newer.resolve([{ id: 2, from: 'A', ts: 2, text: 'newer' }]);
  assert.equal(await session.lastPolls[1], 'applied');
  older.resolve([{ id: 1, from: 'A', ts: 1, text: 'older' }]);
  assert.equal(await session.lastPolls[0], 'stale');

  assert.deepEqual(session.state.applied, [{ kind: 'poll', openPeer: 'A' }]);
  assert.deepEqual(session.state.thread.map((message) => message.text), ['newer']);
  assert.deepEqual(relay.acks, [[2]]);
  session.stopPolling();
});

test('ChatPanel keeps using the tested room and ack guards', () => {
  const source = readFileSync(new URL('../components/ChatPanel.js', import.meta.url), 'utf8');
  assert.match(source, /createRoomGuard/);
  assert.match(source, /createAckQueue/);
  assert.match(source, /beginPoll\(\)/);
  assert.match(source, /beginRoomRead\(\)/);
  assert.match(source, /isCurrentPoll\(/);
  assert.match(source, /isCurrentRoomRead\(/);
  assert.match(source, /ackQueue\.run\(/);
  assert.doesNotMatch(source, /viewVersion/);
});