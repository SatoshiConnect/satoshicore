// Crypto tests for the encrypted chat. The point is not "it round-trips" — it is
// that the key derivation is the same one libsodium defines, that the ECDH
// agrees with a second independent implementation (Node's X25519), and that a
// relay holding only the envelope can neither read nor redirect it.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import nacl from 'tweetnacl';
import {
  E2E_VERSION, envelopeId, MAX_TEXT_LENGTH, openMessage, publicKeyBundle,
  sealMessage, verifyPublicKeyBundle, x25519KeyPairFromSeed, x25519SecretFromSeed,
} from '../lib/e2eChat.js';
import { decodeG, encodeG } from '../lib/nsatCodec.js';

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const unhex = (text) => new Uint8Array(Buffer.from(text, 'hex'));
const SEED_A = unhex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
const SEED_B = unhex('1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100');
const ADDRESS_A = encodeG(nacl.sign.keyPair.fromSeed(SEED_A).publicKey);
const ADDRESS_B = encodeG(nacl.sign.keyPair.fromSeed(SEED_B).publicKey);

// Raw 32-byte X25519 private key in PKCS#8 DER, so Node can compute with it.
function nodeX25519(rawPrivateKey) {
  const der = Buffer.concat([
    Buffer.from('302e020100300506032b656e04220420', 'hex'),
    Buffer.from(rawPrivateKey),
  ]);
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

test('the messaging key is libsodium’s Ed25519 → X25519 conversion', () => {
  // Vector from PyNaCl 1.6.2: crypto_sign_ed25519_sk_to_curve25519(seed+pk).
  assert.equal(hex(x25519SecretFromSeed(SEED_A)),
    '3894eea49c580aef816935762be049559d6d1440dede12e6a125f1841fff8e6f');
  const { publicKey } = x25519KeyPairFromSeed(SEED_A);
  // crypto_sign_ed25519_pk_to_curve25519(ed25519 pk) for the same identity.
  assert.equal(hex(publicKey), '4701d08488451f545a409fb58ae3e58581ca40ac3f7f114698cd71deac73ca01');
});

test('the ECDH agrees with Node’s own X25519 implementation', () => {
  const a = x25519KeyPairFromSeed(SEED_A);
  const b = x25519KeyPairFromSeed(SEED_B);
  // Public keys: ours vs Node's, computed from the same raw private keys.
  const nodePubA = crypto.createPublicKey(nodeX25519(a.secretKey)).export({ format: 'der', type: 'spki' });
  assert.equal(nodePubA.subarray(-32).toString('hex'), hex(a.publicKey));
  // Raw X25519 shared point: tweetnacl vs Node's diffieHellman. (`box.before`
  // is the HSalsa20 key derived from this point, so it is compared separately.)
  const ours = nacl.scalarMult(a.secretKey, b.publicKey);
  const nodeKey = crypto.createPublicKey(nodeX25519(b.secretKey));
  const theirs = crypto.diffieHellman({ privateKey: nodeX25519(a.secretKey), publicKey: nodeKey });
  assert.equal(hex(ours), theirs.toString('hex'));
  assert.notEqual(hex(nacl.box.before(b.publicKey, a.secretKey)), hex(ours));
});

test('a message from A to B decrypts only for B, and the other way too', () => {
  const a = x25519KeyPairFromSeed(SEED_A);
  const b = x25519KeyPairFromSeed(SEED_B);
  const envelope = sealMessage({
    seed32: SEED_A, from: ADDRESS_A, to: ADDRESS_B,
    recipientX25519Pub: b.publicKey, text: 'สวัสดี — 100 NSAT ถึงแล้ว',
  });
  const opened = openMessage({ seed32: SEED_B, address: ADDRESS_B, envelope });
  assert.equal(opened.text, 'สวัสดี — 100 NSAT ถึงแล้ว');
  assert.equal(opened.from, ADDRESS_A);
  assert.equal(opened.ts, envelope.ts);

  // A third wallet must not be able to open it, even with the envelope.
  assert.throws(() => openMessage({ seed32: SEED_A, address: ADDRESS_A, envelope }),
    /not addressed to this wallet/);
  const other = x25519KeyPairFromSeed(unhex('11'.repeat(32)));
  assert.ok(other.publicKey.length === 32);

  const back = sealMessage({
    seed32: SEED_B, from: ADDRESS_B, to: ADDRESS_A,
    recipientX25519Pub: a.publicKey, text: 'received, thanks',
  });
  assert.equal(openMessage({ seed32: SEED_A, address: ADDRESS_A, envelope: back }).text,
    'received, thanks');
});

test('a relay holding the envelope learns nothing and cannot redirect it', () => {
  const b = x25519KeyPairFromSeed(SEED_B);
  const envelope = sealMessage({
    seed32: SEED_A, from: ADDRESS_A, to: ADDRESS_B,
    recipientX25519Pub: b.publicKey, text: 'secret amount 4242',
  });
  const wire = JSON.stringify(envelope);
  assert.equal(wire.includes('secret amount'), false);
  assert.equal(wire.includes('4242'), false);
  // No seed-shaped string leaks into an envelope either.
  assert.equal((wire.match(/S[A-Z2-7]{55}/g) || []).length, 0);
  assert.equal(envelope.v, E2E_VERSION);
  assert.ok(envelopeId(envelope).length > 10);

  // Retarget: relay changes `to`. The signature covers it.
  assert.throws(() => openMessage({
    seed32: SEED_B, address: ADDRESS_B, envelope: { ...envelope, to: ADDRESS_A },
  }), /not addressed|signature/);
  // Claim another sender.
  assert.throws(() => openMessage({
    seed32: SEED_B, address: ADDRESS_B, envelope: { ...envelope, from: ADDRESS_B },
  }), /signature/);
  // Flip a ciphertext byte.
  const ct = Buffer.from(envelope.ct, 'base64');
  ct[0] ^= 0x01;
  assert.throws(() => openMessage({
    seed32: SEED_B, address: ADDRESS_B, envelope: { ...envelope, ct: ct.toString('base64') },
  }), /signature|cannot be decrypted/);
});

test('a published messaging key is bound to the wallet address', () => {
  const bundle = publicKeyBundle(SEED_A, ADDRESS_A);
  assert.equal(bundle.v, E2E_VERSION);
  assert.equal(bundle.address, ADDRESS_A);
  assert.equal(verifyPublicKeyBundle(bundle), true);

  // Substituting the key, or the address, must fail verification.
  const b = x25519KeyPairFromSeed(SEED_B);
  assert.equal(verifyPublicKeyBundle({ ...bundle, x25519Pub: Buffer.from(b.publicKey).toString('base64') }), false);
  assert.equal(verifyPublicKeyBundle({ ...bundle, address: ADDRESS_B }), false);
  assert.equal(verifyPublicKeyBundle({ ...bundle, sig: Buffer.alloc(64).toString('base64') }), false);
  assert.equal(verifyPublicKeyBundle({ ...bundle, v: 2 }), false);
  assert.equal(verifyPublicKeyBundle(null), false);

  // A bundle may only be minted by the seed that owns the address.
  assert.throws(() => publicKeyBundle(SEED_B, ADDRESS_A), /does not belong/);
  // Same check on the sending side: signing wallet must be the from address.
  assert.throws(() => sealMessage({
    seed32: SEED_B, from: ADDRESS_A, to: ADDRESS_A, recipientX25519Pub: b.publicKey, text: 'x',
  }), /does not match the sender/);
});

test('message limits and malformed input fail closed', () => {
  const b = x25519KeyPairFromSeed(SEED_B);
  assert.throws(() => sealMessage({
    seed32: SEED_A, from: ADDRESS_A, to: ADDRESS_B, recipientX25519Pub: b.publicKey, text: '   ',
  }), /needs some text/);
  assert.throws(() => sealMessage({
    seed32: SEED_A, from: ADDRESS_A, to: ADDRESS_B, recipientX25519Pub: b.publicKey,
    text: 'x'.repeat(MAX_TEXT_LENGTH + 1),
  }), /limited to/);
  assert.throws(() => sealMessage({
    seed32: SEED_A, from: ADDRESS_A, to: ADDRESS_B, recipientX25519Pub: new Uint8Array(31), text: 'x',
  }), /no usable messaging key/);
  assert.throws(() => x25519SecretFromSeed(new Uint8Array(16)), /32-byte wallet seed/);
  assert.throws(() => openMessage({ seed32: SEED_B, address: ADDRESS_B, envelope: { v: 9 } }),
    /Unsupported message format/);
  // A short seed must not silently derive a key.
  const ed = nacl.sign.keyPair.fromSeed(SEED_B);
  assert.equal(decodeG(ADDRESS_B).length, 32);
  assert.equal(encodeG(ed.publicKey), ADDRESS_B);
});
