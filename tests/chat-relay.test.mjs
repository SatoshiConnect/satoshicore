// The relay is the only party that could leak a conversation: these tests pin
// that it authorises by wallet signature, stores only what it was given, and
// never hands a message to an address it is not addressed to.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import nacl from 'tweetnacl';
import { createChatRelay, decodeAddress, requestString, verifySignedRequest } from '../services/api-gateway/chat-relay.mjs';
import { publicKeyBundle, sealMessage, x25519KeyPairFromSeed } from '../lib/e2eChat.js';
import { encodeG } from '../lib/nsatCodec.js';

const unhex = (text) => new Uint8Array(Buffer.from(text, 'hex'));
const SEED_A = unhex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
const SEED_B = unhex('1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100');
const SEED_C = new Uint8Array(32).fill(9);
const KEY_A = nacl.sign.keyPair.fromSeed(SEED_A);
const KEY_B = nacl.sign.keyPair.fromSeed(SEED_B);
const KEY_C = nacl.sign.keyPair.fromSeed(SEED_C);
const ADDRESS_A = encodeG(KEY_A.publicKey);
const ADDRESS_B = encodeG(KEY_B.publicKey);
const ADDRESS_C = encodeG(KEY_C.publicKey);

let dir;
let relay;

before(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'nsat-chat-'));
  relay = createChatRelay({ dbPath: path.join(dir, 'relay.sqlite') });
});

after(() => {
  relay?.close();
  rmSync(dir, { recursive: true, force: true });
});

let nonceCounter = 0;
function signed({
  keyPair, address, method, path: requestPath, body = null, query, ts = Date.now(), device = '',
}) {
  nonceCounter += 1;
  const nonce = `nonce-${nonceCounter}-${Math.random().toString(36).slice(2, 10)}`;
  const signature = nacl.sign.detached(
    Buffer.from(requestString({ method, path: requestPath, address, ts, nonce, device })),
    keyPair.secretKey,
  );
  return {
    method,
    path: requestPath,
    headers: {
      'x-nsat-address': address,
      ...(device ? { 'x-nsat-device': device } : {}),
      'x-nsat-ts': String(ts),
      'x-nsat-nonce': nonce,
      'x-nsat-signature': Buffer.from(signature).toString('base64'),
    },
    body,
    ...(query ? { query } : {}),
  };
}

test('an address decodes to its ed25519 key and a bad checksum is refused', () => {
  assert.equal(Buffer.from(decodeAddress(ADDRESS_A)).toString('hex'), Buffer.from(KEY_A.publicKey).toString('hex'));
  const broken = `${ADDRESS_A.slice(0, -1)}${ADDRESS_A.endsWith('A') ? 'B' : 'A'}`;
  assert.equal(decodeAddress(broken), null);
  assert.equal(decodeAddress('Gshort'), null);
  assert.equal(decodeAddress(undefined), null);
});

test('requests without a valid wallet signature are refused', () => {
  const good = signed({ keyPair: KEY_A, address: ADDRESS_A, method: 'GET', path: '/api/v1/chat/messages' });
  assert.equal(verifySignedRequest(good), ADDRESS_A);

  // Signed by another wallet.
  const forged = signed({ keyPair: KEY_B, address: ADDRESS_A, method: 'GET', path: '/api/v1/chat/messages' });
  assert.equal(verifySignedRequest(forged), null);
  // Tampered path (the signature covers it).
  assert.equal(verifySignedRequest({ ...good, path: '/api/v1/chat/ack' }), null);
  // Stale timestamp.
  const old = signed({ keyPair: KEY_A, address: ADDRESS_A, method: 'GET', path: '/api/v1/chat/messages', ts: Date.now() - 10 * 60_000 });
  assert.equal(verifySignedRequest(old), null);
  // Unsigned.
  assert.equal(verifySignedRequest({ method: 'GET', path: '/x', headers: {} }), null);
});

test('a published key can be read by anyone, a bad one is rejected', () => {
  const bundle = publicKeyBundle(SEED_A, ADDRESS_A);
  const put = relay.handle(signed({ keyPair: KEY_A, address: ADDRESS_A, method: 'POST', path: '/api/v1/chat/keys', body: { bundle } }));
  assert.equal(put.status, 200);

  const got = relay.handle({ method: 'GET', path: '/api/v1/chat/keys', query: { address: ADDRESS_A } });
  assert.equal(got.status, 200);
  assert.equal(got.body.bundle.address, ADDRESS_A);

  const missing = relay.handle({ method: 'GET', path: '/api/v1/chat/keys', query: { address: ADDRESS_B } });
  assert.equal(missing.status, 404);

  // Publishing under someone else's address is refused.
  const stolen = relay.handle(signed({
    keyPair: KEY_B, address: ADDRESS_B, method: 'POST', path: '/api/v1/chat/keys',
    body: { bundle }, // bundle.address is A, signer is B
  }));
  assert.equal(stolen.status, 400);
  // Unauthenticated publish is refused.
  assert.equal(relay.handle({ method: 'POST', path: '/api/v1/chat/keys', headers: {}, body: { bundle } }).status, 401);
});

test('a device id is signed and cannot be swapped after signing', () => {
  const laptop = 'laptop-device-0001';
  const phone = 'phone-device-0001';
  const request = signed({
    keyPair: KEY_A, address: ADDRESS_A, method: 'GET', path: '/api/v1/chat/messages', device: laptop,
  });
  assert.equal(verifySignedRequest(request), ADDRESS_A);

  // Moving the same signature to another device changes the request line.
  const swapped = { ...request, headers: { ...request.headers, 'x-nsat-device': phone } };
  assert.equal(verifySignedRequest(swapped), null);

  // Adding a device to a v1 signature is not a valid v2 signature either.
  const v1 = signed({ keyPair: KEY_A, address: ADDRESS_A, method: 'GET', path: '/api/v1/chat/messages' });
  assert.equal(verifySignedRequest({ ...v1, headers: { ...v1.headers, 'x-nsat-device': laptop } }), null);

  // A malformed device header fails closed instead of falling back to legacy.
  assert.equal(verifySignedRequest({
    ...v1, headers: { ...v1.headers, 'x-nsat-device': 'short' },
  }), null);
});

test('a message is delivered to its recipient only, and ack deletes it', () => {
  const bKeys = x25519KeyPairFromSeed(SEED_B);
  const envelope = sealMessage({
    seed32: SEED_A, from: ADDRESS_A, to: ADDRESS_B,
    recipientX25519Pub: bKeys.publicKey, text: 'ledger 42 confirmed',
  });
  const sent = relay.handle(signed({
    keyPair: KEY_A, address: ADDRESS_A, method: 'POST', path: '/api/v1/chat/messages', body: { envelope },
  }));
  assert.equal(sent.status, 200);

  const inboxB = relay.handle(signed({ keyPair: KEY_B, address: ADDRESS_B, method: 'GET', path: '/api/v1/chat/messages' }));
  assert.equal(inboxB.status, 200);
  assert.equal(inboxB.body.messages.length, 1);
  const [message] = inboxB.body.messages;
  assert.equal(message.envelope.from, ADDRESS_A);
  assert.equal(message.envelope.to, ADDRESS_B);
  assert.equal(JSON.stringify(message).includes('ledger 42 confirmed'), false);

  // A different wallet's inbox is empty: the relay never copies to the sender.
  const inboxA = relay.handle(signed({ keyPair: KEY_A, address: ADDRESS_A, method: 'GET', path: '/api/v1/chat/messages' }));
  assert.equal(inboxA.body.messages.length, 0);

  const ack = relay.handle(signed({
    keyPair: KEY_B, address: ADDRESS_B, method: 'POST', path: '/api/v1/chat/ack', body: { ids: [message.id] },
  }));
  assert.equal(ack.status, 200);
  const afterAck = relay.handle(signed({ keyPair: KEY_B, address: ADDRESS_B, method: 'GET', path: '/api/v1/chat/messages' }));
  assert.equal(afterAck.body.messages.length, 0);
});

test('a retried client id stores one message and returns the original id', () => {
  const bKeys = x25519KeyPairFromSeed(SEED_B);
  const envelope = sealMessage({
    seed32: SEED_A, from: ADDRESS_A, to: ADDRESS_B,
    recipientX25519Pub: bKeys.publicKey, text: 'idempotent delivery',
  });
  const body = { envelope, clientId: 'retry-client-0001' };
  const first = relay.handle(signed({
    keyPair: KEY_A, address: ADDRESS_A, method: 'POST', path: '/api/v1/chat/messages', body,
  }));
  assert.equal(first.status, 200);
  assert.equal(Number.isSafeInteger(first.body.id), true);

  const again = relay.handle(signed({
    keyPair: KEY_A, address: ADDRESS_A, method: 'POST', path: '/api/v1/chat/messages', body,
  }));
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(again.body.id, first.body.id);

  // Even a different envelope under the same client id must not become a
  // second message: the idempotency key is the identity of the send attempt.
  const changed = relay.handle(signed({
    keyPair: KEY_A, address: ADDRESS_A, method: 'POST', path: '/api/v1/chat/messages',
    body: { clientId: 'retry-client-0001', envelope: { ...envelope, box: 'different' } },
  }));
  assert.equal(changed.body.id, first.body.id);

  const inbox = relay.handle(signed({
    keyPair: KEY_B, address: ADDRESS_B, method: 'GET', path: '/api/v1/chat/messages',
  }));
  const matching = inbox.body.messages.filter((row) => row.id === first.body.id);
  assert.equal(matching.length, 1);

  const invalid = relay.handle(signed({
    keyPair: KEY_A, address: ADDRESS_A, method: 'POST', path: '/api/v1/chat/messages',
    body: { ...body, clientId: 'bad id with spaces' },
  }));
  assert.equal(invalid.status, 400);
});

test('ack removes only the device that read the message', () => {
  const laptop = 'laptop-device-0001';
  const phone = 'phone-device-0001';
  // Both devices have identified themselves before the message arrives, so the
  // relay fans it out to both mailboxes.
  relay.handle(signed({
    keyPair: KEY_C, address: ADDRESS_C, method: 'GET', path: '/api/v1/chat/messages', device: laptop,
  }));
  relay.handle(signed({
    keyPair: KEY_C, address: ADDRESS_C, method: 'GET', path: '/api/v1/chat/messages', device: phone,
  }));

  const cKeys = x25519KeyPairFromSeed(SEED_C);
  const envelope = sealMessage({
    seed32: SEED_A, from: ADDRESS_A, to: ADDRESS_C,
    recipientX25519Pub: cKeys.publicKey, text: 'read on the laptop only',
  });
  assert.equal(relay.handle(signed({
    keyPair: KEY_A, address: ADDRESS_A, method: 'POST', path: '/api/v1/chat/messages', body: { envelope },
  })).status, 200);

  const inbox = (device) => relay.handle(signed({
    keyPair: KEY_C, address: ADDRESS_C, method: 'GET', path: '/api/v1/chat/messages', device,
  })).body.messages;
  const onLaptop = inbox(laptop);
  const onPhone = inbox(phone);
  assert.equal(onLaptop.length, 1);
  assert.equal(onPhone.length, 1);

  // The laptop reads and acknowledges: its copy goes, the phone's stays.
  const laptopAck = relay.handle(signed({
    keyPair: KEY_C, address: ADDRESS_C, method: 'POST', path: '/api/v1/chat/ack',
    device: laptop, body: { ids: onLaptop.map((message) => message.id) },
  }));
  assert.deepEqual(laptopAck.body, { ok: true, acked: 1, deleted: 0 });
  assert.equal(inbox(laptop).length, 0);
  assert.equal(inbox(phone).length, 1);

  // The phone acknowledging the same id removes the envelope for good.
  const phoneAck = relay.handle(signed({
    keyPair: KEY_C, address: ADDRESS_C, method: 'POST', path: '/api/v1/chat/ack',
    device: phone, body: { ids: onPhone.map((message) => message.id) },
  }));
  assert.deepEqual(phoneAck.body, { ok: true, acked: 1, deleted: 1 });
  assert.equal(inbox(phone).length, 0);
});

test('one device acking a wallet cannot clear another wallet on the same browser', () => {
  const localDir = mkdtempSync(path.join(os.tmpdir(), 'nsat-chat-shared-device-'));
  const local = createChatRelay({ dbPath: path.join(localDir, 'relay.sqlite') });
  const device = 'shared-browser-0001';
  try {
    // The same browser profile holds two wallets, so both see this device id.
    local.handle(signed({
      keyPair: KEY_B, address: ADDRESS_B, method: 'GET', path: '/api/v1/chat/messages', device,
    }));
    local.handle(signed({
      keyPair: KEY_C, address: ADDRESS_C, method: 'GET', path: '/api/v1/chat/messages', device,
    }));

    const toB = sealMessage({
      seed32: SEED_A, from: ADDRESS_A, to: ADDRESS_B,
      recipientX25519Pub: x25519KeyPairFromSeed(SEED_B).publicKey, text: 'for b',
    });
    const toC = sealMessage({
      seed32: SEED_A, from: ADDRESS_A, to: ADDRESS_C,
      recipientX25519Pub: x25519KeyPairFromSeed(SEED_C).publicKey, text: 'for c',
    });
    local.handle(signed({
      keyPair: KEY_A, address: ADDRESS_A, method: 'POST', path: '/api/v1/chat/messages', body: { envelope: toB },
    }));
    local.handle(signed({
      keyPair: KEY_A, address: ADDRESS_A, method: 'POST', path: '/api/v1/chat/messages', body: { envelope: toC },
    }));

    const inbox = (keyPair, address) => local.handle(signed({
      keyPair, address, method: 'GET', path: '/api/v1/chat/messages', device,
    })).body.messages;
    const messageB = inbox(KEY_B, ADDRESS_B)[0];
    const messageC = inbox(KEY_C, ADDRESS_C)[0];
    assert.ok(messageB && messageC);

    // B names C's id too; the recipient scope must ignore it.
    const ack = local.handle(signed({
      keyPair: KEY_B, address: ADDRESS_B, method: 'POST', path: '/api/v1/chat/ack',
      device, body: { ids: [messageB.id, messageC.id] },
    }));
    assert.deepEqual(ack.body, { ok: true, acked: 1, deleted: 1 });
    assert.equal(inbox(KEY_C, ADDRESS_C).length, 1);
  } finally {
    local.close();
    rmSync(localDir, { recursive: true, force: true });
  }
});

test('a device that registers late still receives pending mail', () => {
  const phone = 'phone-device-0002';
  // Legacy clients register the shared 'legacy' device and read first.
  relay.handle(signed({
    keyPair: KEY_C, address: ADDRESS_C, method: 'GET', path: '/api/v1/chat/messages',
  }));

  const cKeys = x25519KeyPairFromSeed(SEED_C);
  const envelope = sealMessage({
    seed32: SEED_A, from: ADDRESS_A, to: ADDRESS_C,
    recipientX25519Pub: cKeys.publicKey, text: 'waiting for the phone',
  });
  assert.equal(relay.handle(signed({
    keyPair: KEY_A, address: ADDRESS_A, method: 'POST', path: '/api/v1/chat/messages', body: { envelope },
  })).status, 200);

  const legacyInbox = relay.handle(signed({
    keyPair: KEY_C, address: ADDRESS_C, method: 'GET', path: '/api/v1/chat/messages',
  })).body.messages;
  assert.equal(legacyInbox.length, 1);

  // First contact from the phone backfills what is still pending.
  const phoneInbox = relay.handle(signed({
    keyPair: KEY_C, address: ADDRESS_C, method: 'GET', path: '/api/v1/chat/messages', device: phone,
  })).body.messages;
  assert.equal(phoneInbox.length, 1);

  // The legacy client acknowledging does not remove the phone's copy.
  const legacyAck = relay.handle(signed({
    keyPair: KEY_C, address: ADDRESS_C, method: 'POST', path: '/api/v1/chat/ack',
    body: { ids: legacyInbox.map((message) => message.id) },
  }));
  assert.deepEqual(legacyAck.body, { ok: true, acked: 1, deleted: 0 });
  const phoneAfter = relay.handle(signed({
    keyPair: KEY_C, address: ADDRESS_C, method: 'GET', path: '/api/v1/chat/messages', device: phone,
  })).body.messages;
  assert.equal(phoneAfter.length, 1);
});

test('sending on behalf of another wallet, replays and oversize bodies fail closed', () => {
  const bKeys = x25519KeyPairFromSeed(SEED_B);
  const envelope = sealMessage({
    seed32: SEED_A, from: ADDRESS_A, to: ADDRESS_B, recipientX25519Pub: bKeys.publicKey, text: 'hi',
  });
  // B signs a request that claims A as the envelope sender.
  const impersonation = relay.handle(signed({
    keyPair: KEY_B, address: ADDRESS_B, method: 'POST', path: '/api/v1/chat/messages', body: { envelope },
  }));
  assert.equal(impersonation.status, 403);

  const request = signed({
    keyPair: KEY_A, address: ADDRESS_A, method: 'POST', path: '/api/v1/chat/messages', body: { envelope },
  });
  relay.handle(request);
  // Same nonce again: refused as a replay.
  const replay = relay.handle(request);
  assert.equal(replay.status, 409);

  const huge = { ...envelope, ct: 'A'.repeat(20_000) };
  const tooBig = relay.handle(signed({
    keyPair: KEY_A, address: ADDRESS_A, method: 'POST', path: '/api/v1/chat/messages', body: { envelope: huge },
  }));
  assert.equal(tooBig.status, 413);
});

// The replay guard used to be an in-memory Map: after a restart, a captured
// request could be replayed inside the freshness window. The nonce row is now
// part of the database.
test('a captured request cannot be replayed after the relay restarts', () => {
  const restartDir = mkdtempSync(path.join(os.tmpdir(), 'nsat-chat-restart-'));
  const dbPath = path.join(restartDir, 'relay.sqlite');
  const request = signed({
    keyPair: KEY_C,
    address: ADDRESS_C,
    method: 'GET',
    path: '/api/v1/chat/messages',
    device: 'restart-device-1',
  });

  const first = createChatRelay({ dbPath });
  assert.equal(first.handle(request).status, 200);
  first.close();

  const second = createChatRelay({ dbPath });
  try {
    assert.equal(second.handle(request).status, 409);
  } finally {
    second.close();
    rmSync(restartDir, { recursive: true, force: true });
  }
});

test('read receipts move forward and are readable only by the sender', () => {
  const bKeys = x25519KeyPairFromSeed(SEED_B);
  const envelope = sealMessage({
    seed32: SEED_A, from: ADDRESS_A, to: ADDRESS_B,
    recipientX25519Pub: bKeys.publicKey, text: 'receipt test',
  });
  const sent = relay.handle(signed({
    keyPair: KEY_A, address: ADDRESS_A, method: 'POST', path: '/api/v1/chat/messages', body: { envelope },
  }));
  assert.equal(sent.status, 200);

  const events = [];
  const unsubscribe = relay.subscribe((event) => events.push(event));
  const marked = relay.handle(signed({
    keyPair: KEY_B, address: ADDRESS_B, method: 'POST', path: '/api/v1/chat/read',
    body: { peer: ADDRESS_A, id: sent.body.id },
  }));
  assert.equal(marked.status, 200);
  // The sender gets a read frame addressed to them, with no message text.
  const readEvent = events.find((event) => event.type === 'read');
  assert.equal(readEvent.recipient, ADDRESS_A);
  assert.equal(readEvent.from, ADDRESS_B);
  assert.equal(readEvent.lastId, sent.body.id);
  unsubscribe();

  const receipt = relay.handle(signed({
    keyPair: KEY_A, address: ADDRESS_A, method: 'GET', path: '/api/v1/chat/read',
    query: { peer: ADDRESS_B },
  }));
  assert.equal(receipt.status, 200);
  assert.equal(receipt.body.lastId, sent.body.id);

  // An out-of-order mark must not move the receipt backwards.
  relay.handle(signed({
    keyPair: KEY_B, address: ADDRESS_B, method: 'POST', path: '/api/v1/chat/read',
    body: { peer: ADDRESS_A, id: 1 },
  }));
  const still = relay.handle(signed({
    keyPair: KEY_A, address: ADDRESS_A, method: 'GET', path: '/api/v1/chat/read',
    query: { peer: ADDRESS_B },
  }));
  assert.equal(still.body.lastId, sent.body.id);

  // A third wallet sees no receipt for mail it did not send.
  const foreign = relay.handle(signed({
    keyPair: KEY_C, address: ADDRESS_C, method: 'GET', path: '/api/v1/chat/read',
    query: { peer: ADDRESS_B },
  }));
  assert.equal(foreign.body.lastId, 0);
});

test('the event stream authenticates and only wakes the addressed recipient', () => {
  const stream = signed({
    keyPair: KEY_B, address: ADDRESS_B, method: 'GET', path: '/api/v1/chat/events',
    device: 'stream-device-01',
  });
  const auth = relay.authenticate(stream);
  assert.equal(auth.address, ADDRESS_B);
  // The same signed handshake cannot be replayed.
  assert.equal(relay.authenticate(stream), null);
  assert.equal(relay.authenticate(signed({
    keyPair: KEY_C, address: ADDRESS_C, method: 'GET', path: '/api/v1/chat/events',
  })).address, ADDRESS_C);

  const events = [];
  const unsubscribe = relay.subscribe((event) => events.push(event));
  const bKeys = x25519KeyPairFromSeed(SEED_B);
  const envelope = sealMessage({
    seed32: SEED_A, from: ADDRESS_A, to: ADDRESS_B,
    recipientX25519Pub: bKeys.publicKey, text: 'wake up',
  });
  const sent = relay.handle(signed({
    keyPair: KEY_A, address: ADDRESS_A, method: 'POST', path: '/api/v1/chat/messages', body: { envelope },
  }));
  assert.equal(events.length, 1);
  assert.equal(events[0].recipient, ADDRESS_B);
  assert.equal(events[0].id, sent.body.id);
  unsubscribe();
});

test('delete-for-everyone removes the ciphertext and leaves an id-only tombstone', () => {
  const bKeys = x25519KeyPairFromSeed(SEED_B);
  const envelope = sealMessage({
    seed32: SEED_A, from: ADDRESS_A, to: ADDRESS_B,
    recipientX25519Pub: bKeys.publicKey, text: 'delete me',
  });
  const sent = relay.handle(signed({
    keyPair: KEY_A, address: ADDRESS_A, method: 'POST', path: '/api/v1/chat/messages', body: { envelope },
  }));
  const id = sent.body.id;

  const notOwner = relay.handle(signed({
    keyPair: KEY_B, address: ADDRESS_B, method: 'POST', path: '/api/v1/chat/messages/delete', body: { id },
  }));
  assert.equal(notOwner.status, 403);

  const deleted = relay.handle(signed({
    keyPair: KEY_A, address: ADDRESS_A, method: 'POST', path: '/api/v1/chat/messages/delete', body: { id },
  }));
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.deleted, true);

  const inbox = relay.handle(signed({
    keyPair: KEY_B, address: ADDRESS_B, method: 'GET', path: '/api/v1/chat/messages',
  }));
  assert.equal(inbox.body.messages.some((row) => row.id === id), false);

  const recipientTombstones = relay.handle(signed({
    keyPair: KEY_B, address: ADDRESS_B, method: 'GET', path: '/api/v1/chat/tombstones',
  }));
  assert.deepEqual(recipientTombstones.body.deletions.map((row) => row.id), [id]);
  assert.equal(recipientTombstones.body.deletions[0].peer, ADDRESS_A);

  // The sender's other devices see the same id, and an unrelated wallet does not.
  const senderTombstones = relay.handle(signed({
    keyPair: KEY_A, address: ADDRESS_A, method: 'GET', path: '/api/v1/chat/tombstones',
  }));
  assert.equal(senderTombstones.body.deletions.some((row) => row.id === id), true);
  const foreign = relay.handle(signed({
    keyPair: KEY_C, address: ADDRESS_C, method: 'GET', path: '/api/v1/chat/tombstones',
  }));
  assert.equal(foreign.body.deletions.some((row) => row.id === id), false);
});

test('presence is opt-in and only disclosed to a wallet with shared history', () => {
  const bKeys = x25519KeyPairFromSeed(SEED_B);
  const envelope = sealMessage({
    seed32: SEED_A, from: ADDRESS_A, to: ADDRESS_B,
    recipientX25519Pub: bKeys.publicKey, text: 'presence history',
  });
  assert.equal(relay.handle(signed({
    keyPair: KEY_A, address: ADDRESS_A, method: 'POST', path: '/api/v1/chat/messages', body: { envelope },
  })).status, 200);
  const heartbeat = relay.handle(signed({
    keyPair: KEY_B, address: ADDRESS_B, method: 'POST', path: '/api/v1/chat/presence',
    body: { online: true },
  }));
  assert.equal(heartbeat.status, 200);
  const seen = relay.handle(signed({
    keyPair: KEY_A, address: ADDRESS_A, method: 'GET', path: '/api/v1/chat/presence',
    query: { peer: ADDRESS_B },
  }));
  assert.equal(seen.body.known, true);
  assert.equal(seen.body.online, true);

  const stranger = relay.handle(signed({
    keyPair: KEY_C, address: ADDRESS_C, method: 'GET', path: '/api/v1/chat/presence',
    query: { peer: ADDRESS_B },
  }));
  assert.equal(stranger.body.known, false);
  assert.equal(stranger.body.online, false);

  relay.handle(signed({
    keyPair: KEY_B, address: ADDRESS_B, method: 'POST', path: '/api/v1/chat/presence',
    body: { online: false },
  }));
  const offline = relay.handle(signed({
    keyPair: KEY_A, address: ADDRESS_A, method: 'GET', path: '/api/v1/chat/presence',
    query: { peer: ADDRESS_B },
  }));
  assert.equal(offline.body.online, false);
});

test('typing is ephemeral, addressed, and rate-limited', () => {
  const events = [];
  const unsubscribe = relay.subscribe((event) => events.push(event));
  const start = relay.handle(signed({
    keyPair: KEY_A, address: ADDRESS_A, method: 'POST', path: '/api/v1/chat/typing',
    body: { peer: ADDRESS_B, typing: true },
  }));
  assert.equal(start.status, 200);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'typing');
  assert.equal(events[0].recipient, ADDRESS_B);
  assert.equal(events[0].from, ADDRESS_A);
  assert.ok(events[0].until > Date.now());

  // A second frame inside the cooldown does not wake the peer again.
  const again = relay.handle(signed({
    keyPair: KEY_A, address: ADDRESS_A, method: 'POST', path: '/api/v1/chat/typing',
    body: { peer: ADDRESS_B, typing: true },
  }));
  assert.equal(again.body.suppressed, true);
  assert.equal(events.length, 1);

  const stop = relay.handle(signed({
    keyPair: KEY_A, address: ADDRESS_A, method: 'POST', path: '/api/v1/chat/typing',
    body: { peer: ADDRESS_B, typing: false },
  }));
  assert.equal(stop.status, 200);
  assert.equal(events[1].type, 'typing');
  assert.equal(events[1].until, 0);
  unsubscribe();
});
