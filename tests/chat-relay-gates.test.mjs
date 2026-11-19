// The relay now holds two recipient-side gates: a per-sender daily quota on
// stored mail, and a block list. Both are enforced on the server, so these tests
// drive the relay directly (no HTTP) and assert what it stored, not what a client
// believed. The privacy property matters as much as the refusal: a blocked
// sender must not be able to tell a block from a delivery.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import nacl from 'tweetnacl';
import { createChatRelay, requestString } from '../services/api-gateway/chat-relay.mjs';
import { sealMessage, x25519KeyPairFromSeed } from '../lib/e2eChat.js';
import { encodeG } from '../lib/nsatCodec.js';

const unhex = (text) => new Uint8Array(Buffer.from(text, 'hex'));
const SEED_A = unhex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
const SEED_B = unhex('1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100');
const SEED_C = new Uint8Array(32).fill(7);
const KEY_A = nacl.sign.keyPair.fromSeed(SEED_A);
const KEY_B = nacl.sign.keyPair.fromSeed(SEED_B);
const KEY_C = nacl.sign.keyPair.fromSeed(SEED_C);
const ADDRESS_A = encodeG(KEY_A.publicKey);
const ADDRESS_B = encodeG(KEY_B.publicKey);
const ADDRESS_C = encodeG(KEY_C.publicKey);
const PUB_A = x25519KeyPairFromSeed(SEED_A).publicKey;
const PUB_B = x25519KeyPairFromSeed(SEED_B).publicKey;
const PUB_C = x25519KeyPairFromSeed(SEED_C).publicKey;

const DAY = 86_400_000;

function harness(options = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nsat-chat-gates-'));
  let clock = 1_800_000_000_000;
  const relay = createChatRelay({
    dbPath: path.join(dir, 'relay.sqlite'), now: () => clock, ...options,
  });
  let counter = 0;
  const signed = ({ keyPair, address, method, path: requestPath, body = null }) => {
    counter += 1;
    const nonce = `gates-${counter}-${Math.random().toString(36).slice(2, 10)}`;
    const signature = nacl.sign.detached(
      Buffer.from(requestString({ method, path: requestPath, address, ts: clock, nonce })),
      keyPair.secretKey,
    );
    return {
      method,
      path: requestPath,
      headers: {
        'x-nsat-address': address,
        'x-nsat-ts': String(clock),
        'x-nsat-nonce': nonce,
        'x-nsat-signature': Buffer.from(signature).toString('base64'),
      },
      body,
    };
  };
  const envelopeTo = ({ from, fromSeed, to, toPub, text }) => sealMessage({
    seed32: fromSeed, from, to, recipientX25519Pub: toPub, text,
  });
  const sendBToA = (text) => relay.handle(signed({
    keyPair: KEY_B, address: ADDRESS_B, method: 'POST', path: '/api/v1/chat/messages',
    body: { envelope: envelopeTo({ from: ADDRESS_B, fromSeed: SEED_B, to: ADDRESS_A, toPub: PUB_A, text }) },
  }));
  const sendAToB = (text) => relay.handle(signed({
    keyPair: KEY_A, address: ADDRESS_A, method: 'POST', path: '/api/v1/chat/messages',
    body: { envelope: envelopeTo({ from: ADDRESS_A, fromSeed: SEED_A, to: ADDRESS_B, toPub: PUB_B, text }) },
  }));
  const inboxOf = (keyPair, address) => relay.handle(signed({
    keyPair, address, method: 'GET', path: '/api/v1/chat/messages',
  })).body.messages;
  const block = (ownerKey, owner, peer, action = 'add') => relay.handle(signed({
    keyPair: ownerKey, address: owner, method: 'POST', path: '/api/v1/chat/blocks',
    body: { blocked: peer, action },
  }));
  const blocksOf = (keyPair, address) => relay.handle(signed({
    keyPair, address, method: 'GET', path: '/api/v1/chat/blocks',
  })).body.blocked;
  return {
    relay, signed, sendAToB, sendBToA, inboxOf, block, blocksOf,
    advance(ms) { clock += ms; },
    done() { relay.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('a sender cannot flood one mailbox past the daily quota, and the day resets it', () => {
  const h = harness({ maxPerSenderPerDay: 2 });
  try {
    assert.equal(h.sendBToA('one').status, 200);
    assert.equal(h.sendBToA('two').status, 200);
    const refused = h.sendBToA('three');
    assert.equal(refused.status, 429);
    assert.match(refused.body.error, /daily message limit/);
    assert.equal(h.inboxOf(KEY_A, ADDRESS_A).length, 2, 'nothing extra was stored');

    // The quota is per sender: another wallet is unaffected by B's ceiling.
    const fromC = h.relay.handle(h.signed({
      keyPair: KEY_C, address: ADDRESS_C, method: 'POST', path: '/api/v1/chat/messages',
      body: {
        envelope: sealMessage({
          seed32: SEED_C, from: ADDRESS_C, to: ADDRESS_A,
          recipientX25519Pub: PUB_A, text: 'hello from C',
        }),
      },
    }));
    assert.equal(fromC.status, 200);

    h.advance(DAY);
    assert.equal(h.sendBToA('next day').status, 200, 'a new UTC day restores the allowance');
  } finally {
    h.done();
  }
});

test('blocking clears queued mail and stops delivery in both directions', () => {
  const h = harness();
  try {
    assert.equal(h.sendBToA('older message').status, 200);
    assert.equal(h.sendBToA('another one').status, 200);
    assert.equal(h.inboxOf(KEY_A, ADDRESS_A).length, 2);

    const applied = h.block(KEY_A, ADDRESS_A, ADDRESS_B);
    assert.equal(applied.status, 200);
    assert.equal(applied.body.blocked, true);
    assert.equal(applied.body.cleared, 2, 'mail already sitting on the relay is cleared');
    assert.equal(h.inboxOf(KEY_A, ADDRESS_A).length, 0);

    // The sender is not told: same status and shape as a delivery, no mail stored.
    const dropped = h.sendBToA('after the block');
    assert.equal(dropped.status, 200);
    assert.equal(dropped.body.stored, false);
    assert.equal(h.inboxOf(KEY_A, ADDRESS_A).length, 0);

    // And it holds the other way too: A cannot write to the address A blocked.
    const outbound = h.sendAToB('talking to a blocked address');
    assert.equal(outbound.status, 200);
    assert.equal(outbound.body.stored, false);
    assert.equal(h.inboxOf(KEY_B, ADDRESS_B).length, 0);

    assert.deepEqual(h.blocksOf(KEY_A, ADDRESS_A), [ADDRESS_B]);
    assert.deepEqual(h.blocksOf(KEY_B, ADDRESS_B), [], 'a block is held only by its owner');

    assert.equal(h.block(KEY_A, ADDRESS_A, ADDRESS_B, 'remove').status, 200);
    assert.equal(h.sendBToA('after the unblock').status, 200);
    assert.equal(h.inboxOf(KEY_A, ADDRESS_A).length, 1);
  } finally {
    h.done();
  }
});

test('a dropped message costs the sender no quota', () => {
  const h = harness({ maxPerSenderPerDay: 1 });
  try {
    h.block(KEY_A, ADDRESS_A, ADDRESS_B);
    for (const text of ['one', 'two', 'three']) {
      const dropped = h.sendBToA(text);
      assert.equal(dropped.status, 200);
      assert.equal(dropped.body.stored, false);
    }
    h.block(KEY_A, ADDRESS_A, ADDRESS_B, 'remove');

    // The one message B is allowed today is still available, so nothing was
    // consumed while the block was dropping mail.
    assert.equal(h.sendBToA('the first stored message').status, 200);
    assert.equal(h.sendBToA('the second').status, 429);
  } finally {
    h.done();
  }
});

test('the block endpoints need a signature, a real address and a bounded list', () => {
  const h = harness({ maxBlocksPerOwner: 1 });
  try {
    assert.equal(h.relay.handle({ method: 'GET', path: '/api/v1/chat/blocks', headers: {} }).status, 401);
    assert.equal(h.relay.handle({
      method: 'POST', path: '/api/v1/chat/blocks', headers: {}, body: { blocked: ADDRESS_B },
    }).status, 401);

    // Signed by another wallet, claiming A: refused like every other route.
    const forged = h.signed({
      keyPair: KEY_B, address: ADDRESS_A, method: 'GET', path: '/api/v1/chat/blocks',
    });
    assert.equal(h.relay.handle(forged).status, 401);

    assert.equal(h.block(KEY_A, ADDRESS_A, 'Gshort').status, 400);
    assert.equal(h.block(KEY_A, ADDRESS_A, ADDRESS_A).status, 400, 'blocking yourself is not a state');
    assert.equal(h.block(KEY_A, ADDRESS_A, ADDRESS_B, 'maybe').status, 400);

    assert.equal(h.block(KEY_A, ADDRESS_A, ADDRESS_B).status, 200);
    const full = h.block(KEY_A, ADDRESS_A, ADDRESS_C);
    assert.equal(full.status, 429);
    assert.match(full.body.error, /block list is full/);

    // Blocking twice is a no-op that still answers 200.
    assert.equal(h.block(KEY_A, ADDRESS_A, ADDRESS_B).status, 200);
    assert.deepEqual(h.blocksOf(KEY_A, ADDRESS_A), [ADDRESS_B]);
  } finally {
    h.done();
  }
});

test('a mailbox holds a month of conversation and refuses only past its ceiling', () => {
  const h = harness({ maxPerRecipient: 2 });
  try {
    assert.equal(h.sendBToA('one').status, 200);
    assert.equal(h.sendBToA('two').status, 200);
    const full = h.sendBToA('three');
    assert.equal(full.status, 429);
    assert.match(full.body.error, /mailbox is full/);
    assert.equal(h.inboxOf(KEY_A, ADDRESS_A).length, 2);

    // Clearing one makes room again: reading alone never does.
    const [first] = h.inboxOf(KEY_A, ADDRESS_A);
    const cleared = h.relay.handle(h.signed({
      keyPair: KEY_A, address: ADDRESS_A, method: 'POST', path: '/api/v1/chat/ack',
      body: { ids: [first.id] },
    }));
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.deleted, 1);
    assert.equal(h.sendBToA('four').status, 200);
  } finally {
    h.done();
  }
});

test('mail is kept for 7 days, then collected even on a quiet relay', () => {
  const h = harness({ gcIntervalMs: 60_000 });
  try {
    assert.equal(h.sendBToA('older').status, 200);
    h.advance(6 * DAY);
    assert.equal(h.inboxOf(KEY_A, ADDRESS_A).length, 1, 'still inside retention');

    h.advance(2 * DAY);
    // The next request runs the housekeeping pass; nothing had to be delivered.
    assert.equal(h.inboxOf(KEY_A, ADDRESS_A).length, 0);

    assert.equal(h.sendBToA('after the window').status, 200);
    assert.equal(h.relay.gc(), 0, 'nothing left to collect');
    assert.equal(h.inboxOf(KEY_A, ADDRESS_A).length, 1);
  } finally {
    h.done();
  }
});

test('a mailbox is paged in arrival order and ack reports what it really removed', () => {
  const h = harness();
  try {
    for (const text of ['one', 'two', 'three']) assert.equal(h.sendBToA(text).status, 200);
    const page = (query) => h.relay.handle({
      ...h.signed({ keyPair: KEY_A, address: ADDRESS_A, method: 'GET', path: '/api/v1/chat/messages' }),
      query,
    });
    const first = page({ limit: 2 });
    assert.equal(first.status, 200);
    assert.equal(first.body.messages.length, 2);

    // `since` is the last id already seen, so the next page starts after it.
    const rest = page({ since: first.body.messages[1].id });
    assert.equal(rest.body.messages.length, 1);
    assert.equal(rest.body.messages[0].id > first.body.messages[1].id, true);
    assert.equal(h.inboxOf(KEY_A, ADDRESS_A).length, 3);

    const ids = first.body.messages.map((message) => message.id);
    const cleared = h.relay.handle(h.signed({
      keyPair: KEY_A, address: ADDRESS_A, method: 'POST', path: '/api/v1/chat/ack',
      // A stale id that is already gone must not be counted as deleted.
      body: { ids: [...ids, 999_999] },
    }));
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.deleted, 2);
    assert.equal(h.inboxOf(KEY_A, ADDRESS_A).length, 1);
  } finally {
    h.done();
  }
});

test('expired mail is collected before the mailbox ceiling is applied', () => {
  // The periodic pass is effectively disabled, so only the send path can free
  // the slot: a full mailbox must not reject a sender because of mail that has
  // already outlived retention.
  const h = harness({ gcIntervalMs: 24 * 60 * 60 * 1000, maxPerRecipient: 1, retentionDays: 1 });
  try {
    assert.equal(h.sendBToA('old').status, 200);
    h.advance(2 * DAY);
    assert.equal(h.sendBToA('new').status, 200);
    assert.equal(h.inboxOf(KEY_A, ADDRESS_A).length, 1);
  } finally {
    h.done();
  }
});

test('a mailbox read can be narrowed to one conversation', () => {
  const h = harness();
  try {
    assert.equal(h.sendAToB('from a').status, 200);
    const fromC = h.relay.handle(h.signed({
      keyPair: KEY_C, address: ADDRESS_C, method: 'POST', path: '/api/v1/chat/messages',
      body: {
        envelope: sealMessage({
          seed32: SEED_C, from: ADDRESS_C, to: ADDRESS_B, recipientX25519Pub: PUB_B, text: 'from c',
        }),
      },
    }));
    assert.equal(fromC.status, 200);

    const page = (query) => h.relay.handle({
      ...h.signed({ keyPair: KEY_B, address: ADDRESS_B, method: 'GET', path: '/api/v1/chat/messages' }),
      query,
    });
    assert.equal(page({}).body.messages.length, 2);

    const onlyA = page({ peer: ADDRESS_A });
    assert.equal(onlyA.status, 200);
    assert.equal(onlyA.body.messages.length, 1);
    assert.equal(onlyA.body.messages[0].envelope.from, ADDRESS_A);

    const onlyC = page({ peer: ADDRESS_C });
    assert.equal(onlyC.body.messages.length, 1);
    assert.equal(onlyC.body.messages[0].envelope.from, ADDRESS_C);

    assert.equal(page({ peer: 'Gshort' }).status, 400);
    // `peer` composes with `since`, so one room can be paged on its own.
    assert.equal(page({ peer: ADDRESS_A, since: onlyA.body.messages[0].id }).body.messages.length, 0);
  } finally {
    h.done();
  }
});
