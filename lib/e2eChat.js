// End-to-end encrypted chat for NSAT wallets.
//
// Goal: a message is readable by the two wallets in the conversation and by
// nobody else — not by this site, not by the gateway that relays it, not by the
// indexer. The relay only ever holds an envelope of opaque bytes.
//
// Keys come from the wallet seed the person already has, so there is no second
// secret to back up and no account to register:
//
//   X25519 secret = clamp(SHA-512(seed)[0..32])
//
// which is exactly libsodium's `crypto_sign_ed25519_sk_to_curve25519` (verified
// against a PyNaCl vector in tests/e2e-chat.test.mjs: seed 000102…1f gives the
// clamped scalar 3894ee…8e6f). The X25519 public key is then `scalarMult.base`,
// cross-checked in the same test against Node's own X25519 implementation.
//
// Message seal (per message, forward-secret on the sender side):
//   1. the sender makes an ephemeral X25519 key pair;
//   2. shared = X25519(ephemeral secret, recipient's published X25519 key);
//   3. ciphertext = XSalsa20-Poly1305(shared, random 24-byte nonce, plaintext);
//   4. the envelope (sender address, recipient address, ephemeral public key,
//      nonce, timestamp, ciphertext) is signed with the sender's Ed25519 wallet
//      key, so a relay cannot swap the sender, retarget the message, or forge
//      one — the recipient checks the signature against the `from` address.
//
// What this deliberately does NOT do: implement a Double Ratchet by hand. A
// hand-written ratchet is where real messengers get broken, and this module is
// not the place to invent one; it uses a vetted primitive (tweetnacl box/sign)
// in a documented construction instead. See docs/E2E-CHAT-DESIGN.md for the
// threat model, the metadata that still leaks to the relay, and what a ratchet
// would add.
import nacl from 'tweetnacl';
import { bytesToBase64, base64ToBytes, decodeG, encodeG } from './nsatCodec.js';

export const E2E_VERSION = 1;
export const MAX_TEXT_LENGTH = 2000;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

function wipe(bytes) {
  if (bytes && typeof bytes.fill === 'function') bytes.fill(0);
}

function b64(bytes) {
  return bytesToBase64(bytes);
}

function unb64(text) {
  return base64ToBytes(String(text || ''));
}

/** clamp(SHA-512(seed)[0..32]) — libsodium's Ed25519 → X25519 conversion. */
export function x25519SecretFromSeed(seed32) {
  if (!(seed32 instanceof Uint8Array) || seed32.length !== 32) {
    throw new Error('A 32-byte wallet seed is required for messaging keys.');
  }
  const digest = nacl.hash(seed32);          // SHA-512, 64 bytes
  const scalar = digest.slice(0, 32);
  wipe(digest);
  scalar[0] &= 248;
  scalar[31] &= 127;
  scalar[31] |= 64;
  return scalar;
}

export function x25519KeyPairFromSeed(seed32) {
  const secretKey = x25519SecretFromSeed(seed32);
  const publicKey = nacl.scalarMult.base(secretKey);
  return { publicKey, secretKey };
}

/** Ed25519 signing pair the wallet already uses; here for signatures only. */
function signingKeyFromSeed(seed32) {
  return nacl.sign.keyPair.fromSeed(seed32);
}

function bundleBytes({ address, x25519Pub }) {
  return TEXT_ENCODER.encode(`nsc-key|${E2E_VERSION}|${address}|${x25519Pub}`);
}

/**
 * The publishable half of a messaging identity: the X25519 public key, bound to
 * the wallet address by a signature from the wallet's own Ed25519 key. A relay
 * stores this; a sender verifies it before encrypting to that address.
 */
export function publicKeyBundle(seed32, address) {
  const ed = signingKeyFromSeed(seed32);
  const published = encodeG(ed.publicKey);
  if (String(address || '').toUpperCase() !== published) {
    wipe(ed.secretKey);
    throw new Error('The address does not belong to this wallet seed.');
  }
  const { publicKey: x25519Pub } = x25519KeyPairFromSeed(seed32);
  const body = { address: published, x25519Pub: b64(x25519Pub) };
  const sig = nacl.sign.detached(bundleBytes(body), ed.secretKey);
  wipe(ed.secretKey);
  return { v: E2E_VERSION, ...body, sig: b64(sig) };
}

/** True only when the X25519 key really belongs to the address that published it. */
export function verifyPublicKeyBundle(bundle) {
  try {
    if (!bundle || bundle.v !== E2E_VERSION) return false;
    const address = String(bundle.address || '').toUpperCase();
    if (!/^G[A-Z2-7]{55}$/.test(address)) return false;
    const edPub = decodeG(address);
    if (!edPub || edPub.length !== 32) return false;
    // The address must be the strkey of that very public key (version + checksum).
    if (encodeG(edPub) !== address) return false;
    const xPub = unb64(bundle.x25519Pub);
    if (xPub.length !== 32) return false;
    return nacl.sign.detached.verify(
      bundleBytes({ address, x25519Pub: bundle.x25519Pub }),
      unb64(bundle.sig),
      edPub,
    );
  } catch {
    return false;
  }
}

function envelopeBody({ from, to, ephPub, nonce, ts, ct }) {
  return TEXT_ENCODER.encode(
    `nsc1|${E2E_VERSION}|${from}|${to}|${ephPub}|${nonce}|${ts}|${ct}`,
  );
}

/**
 * Encrypt one message for `to`.
 *
 * `recipientX25519Pub` must come from a bundle that passed
 * verifyPublicKeyBundle(); the caller is expected to check that.
 */
export function sealMessage({ seed32, from, to, recipientX25519Pub, text, ts = Date.now() }) {
  const body = String(text ?? '');
  if (!body.trim()) throw new Error('A message needs some text.');
  if (body.length > MAX_TEXT_LENGTH) {
    throw new Error(`A message is limited to ${MAX_TEXT_LENGTH} characters.`);
  }
  if (!(recipientX25519Pub instanceof Uint8Array) || recipientX25519Pub.length !== 32) {
    throw new Error('The recipient has no usable messaging key.');
  }
  const ed = signingKeyFromSeed(seed32);
  const sender = encodeG(ed.publicKey);
  if (String(from || '').toUpperCase() !== sender) {
    wipe(ed.secretKey);
    throw new Error('The signing wallet does not match the sender address.');
  }

  const ephemeral = nacl.box.keyPair();
  const nonce = nacl.randomBytes(24);
  const ciphertext = nacl.box(
    TEXT_ENCODER.encode(JSON.stringify({ v: E2E_VERSION, text: body })),
    nonce,
    recipientX25519Pub,
    ephemeral.secretKey,
  );
  wipe(ephemeral.secretKey);

  const fields = {
    from: sender,
    to: String(to || '').toUpperCase(),
    ephPub: b64(ephemeral.publicKey),
    nonce: b64(nonce),
    ts: Number(ts),
    ct: b64(ciphertext),
  };
  const sig = nacl.sign.detached(envelopeBody(fields), ed.secretKey);
  wipe(ed.secretKey);
  return { v: E2E_VERSION, ...fields, sig: b64(sig) };
}

/**
 * Verify and decrypt one envelope addressed to `address`.
 *
 * Throws with a plain reason when the envelope is not for this wallet, was
 * altered, or was not signed by the address it claims to come from.
 */
export function openMessage({ seed32, address, envelope }) {
  if (!envelope || envelope.v !== E2E_VERSION) throw new Error('Unsupported message format.');
  const mine = String(address || '').toUpperCase();
  if (String(envelope.to || '').toUpperCase() !== mine) {
    throw new Error('This message is not addressed to this wallet.');
  }
  const from = String(envelope.from || '').toUpperCase();
  if (!/^G[A-Z2-7]{55}$/.test(from)) throw new Error('The sender address is not valid.');

  const edPub = decodeG(from);
  if (!edPub || encodeG(edPub) !== from) throw new Error('The sender address is not valid.');
  const body = envelopeBody({
    from,
    to: String(envelope.to).toUpperCase(),
    ephPub: envelope.ephPub,
    nonce: envelope.nonce,
    ts: envelope.ts,
    ct: envelope.ct,
  });
  const signed = nacl.sign.detached.verify(body, unb64(envelope.sig), edPub);
  if (!signed) throw new Error('The message signature does not match its sender.');

  const ephPub = unb64(envelope.ephPub);
  const nonce = unb64(envelope.nonce);
  if (ephPub.length !== 32 || nonce.length !== 24) throw new Error('The message is malformed.');

  const { secretKey } = x25519KeyPairFromSeed(seed32);
  const plaintext = nacl.box.open(unb64(envelope.ct), nonce, ephPub, secretKey);
  wipe(secretKey);
  if (!plaintext) throw new Error('This message cannot be decrypted by this wallet.');

  let parsed;
  try {
    parsed = JSON.parse(TEXT_DECODER.decode(plaintext));
  } catch {
    throw new Error('The message body is not readable.');
  } finally {
    wipe(plaintext);
  }
  if (!parsed || parsed.v !== E2E_VERSION || typeof parsed.text !== 'string') {
    throw new Error('The message body is not readable.');
  }
  return { from, to: mine, ts: Number(envelope.ts), text: parsed.text };
}

/** A stable id a relay can use without learning the content. */
export function envelopeId(envelope) {
  return bytesToBase64(nacl.hash(
    TEXT_ENCODER.encode(`${envelope.from}|${envelope.to}|${envelope.ephPub}|${envelope.ct}`),
  )).slice(0, 22);
}
