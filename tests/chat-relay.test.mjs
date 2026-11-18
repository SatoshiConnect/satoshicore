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
const KEY_A = nacl.sign.keyPair.fromSeed(SEED_A);
const KEY_B = nacl.sign.keyPair.fromSeed(SEED_B);
const ADDRESS_A = encodeG(KEY_A.publicKey);
const ADDRESS_B = encodeG(KEY_B.publicKey);

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
function signed({ keyPair, address, method, path: requestPath, body = null, ts = Date.now() }) {
  nonceCounter += 1;
  const nonce = `nonce-${nonceCounter}-${Math.random().toString(36).slice(2, 10)}`;
  const signature = nacl.sign.detached(
    Buffer.from(requestString({ method, path: requestPath, address, ts, nonce })),
    keyPair.secretKey,
  );
  return {
    method,
    path: requestPath,
    headers: {
      'x-nsat-address': address,
      'x-nsat-ts': String(ts),
      'x-nsat-nonce': nonce,
      'x-nsat-signature': Buffer.from(signature).toString('base64'),
    },
    body,
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
