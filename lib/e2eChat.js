// End-to-end encrypted chat for NSAT wallets.
//
// Goal: a message is readable by the two wallets in the conversation and by
// nobody else — not by this site, not by the gateway that relays it, not by the
// indexer. The relay only ever holds an envelope of opaque bytes.
//
// v1 keys come from the wallet seed the person already has. v2 adds a separate
// device chat identity, delegated by the wallet once, so chat can keep working
// while the wallet itself is locked; see lib/chatIdentity.js. Both versions
// share the same construction:
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
export const CHAT_IDENTITY_VERSION = 2;
export const CHAT_DELEGATION_VERSION = 1;
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

function delegationBytes({ address, chatPub }) {
  return TEXT_ENCODER.encode(
    `nsc-chat-delegation|${CHAT_DELEGATION_VERSION}|${address}|${chatPub}`,
  );
}

function chatBundleBytes({ address, chatPub, x25519Pub, x25519ChatPub }) {
  return TEXT_ENCODER.encode(
    `nsc-key|${CHAT_IDENTITY_VERSION}|${address}|${chatPub}|${x25519Pub}|${x25519ChatPub}`,
  );
}

/** The wallet signs this once to bind a separate chat identity to its address. */
export function chatDelegationString({ address, chatPub }) {
  return delegationBytes({ address, chatPub }).toString();
}

export function signChatDelegation({ walletSeed32, address, chatPub }) {
  const ed = signingKeyFromSeed(walletSeed32);
  const own = encodeG(ed.publicKey);
  if (own !== String(address || '').toUpperCase()) {
    wipe(ed.secretKey);
    throw new Error('The wallet seed does not match the address.');
  }
  const sig = nacl.sign.detached(delegationBytes({ address: own, chatPub }), ed.secretKey);
  wipe(ed.secretKey);
  return b64(sig);
}

export function verifyChatDelegation({ address, chatPub, delegation }) {
  try {
    const owner = String(address || '').toUpperCase();
    const edPub = decodeG(owner);
    if (!edPub || encodeG(edPub) !== owner) return false;
    const key = unb64(chatPub);
    if (key.length !== 32) return false;
    return nacl.sign.detached.verify(
      delegationBytes({ address: owner, chatPub }),
      unb64(delegation),
      edPub,
    );
  } catch {
    return false;
  }
}

/** The public half of a chat identity, bound to a wallet address by delegation. */
export function chatIdentityFromSeed({ seed32, walletSeed32 = null, address, delegation }) {
  const chat = signingKeyFromSeed(seed32);
  const chatPub = b64(chat.publicKey);
  const { publicKey: x25519Pub } = x25519KeyPairFromSeed(seed32);
  const legacy = walletSeed32 instanceof Uint8Array && walletSeed32.length === 32
    ? x25519KeyPairFromSeed(walletSeed32).publicKey
    : null;
  wipe(chat.secretKey);
  return {
    v: CHAT_IDENTITY_VERSION,
    address: String(address || '').toUpperCase(),
    seed32,
    chatPub,
    x25519Pub: b64(x25519Pub),
    legacyX25519Pub: legacy ? b64(legacy) : '',
    delegation,
  };
}

/** Publishable v2 chat bundle, signed by the chat identity itself. */
export function chatPublicKeyBundle({ seed32, address, delegation, legacyX25519Pub = '' }) {
  const identity = chatIdentityFromSeed({ seed32, address, delegation });
  const legacy = String(legacyX25519Pub || identity.legacyX25519Pub || '');
  if (!legacy) throw new Error('The wallet key is needed to publish a compatible chat bundle.');
  const chat = signingKeyFromSeed(seed32);
  const body = {
    address: identity.address,
    chatPub: identity.chatPub,
    x25519Pub: legacy,
    x25519ChatPub: identity.x25519Pub,
  };
  const sig = nacl.sign.detached(chatBundleBytes(body), chat.secretKey);
  wipe(chat.secretKey);
  return {
    v: CHAT_IDENTITY_VERSION,
    ...body,
    delegation,
    sig: b64(sig),
  };
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
    if (bundle?.v === CHAT_IDENTITY_VERSION) {
      const address = String(bundle.address || '').toUpperCase();
      const chatPub = String(bundle.chatPub || '');
      const xPub = unb64(bundle.x25519Pub);
      const chatXPub = unb64(bundle.x25519ChatPub || bundle.x25519Pub);
      if (!/^G[A-Z2-7]{55}$/.test(address)) return false;
      if (unb64(chatPub).length !== 32 || xPub.length !== 32 || chatXPub.length !== 32) return false;
      if (!verifyChatDelegation({ address, chatPub, delegation: bundle.delegation })) return false;
      return nacl.sign.detached.verify(
        chatBundleBytes({
          address, chatPub, x25519Pub: bundle.x25519Pub,
          x25519ChatPub: bundle.x25519ChatPub || bundle.x25519Pub,
        }),
        unb64(bundle.sig),
        unb64(chatPub),
      );
    }
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

function chatEnvelopeBody({ from, fromChat, fromDelegation, to, ephPub, nonce, ts, ct }) {
  return TEXT_ENCODER.encode(
    `nsc2|${CHAT_IDENTITY_VERSION}|${from}|${fromChat}|${fromDelegation}|${to}|${ephPub}|${nonce}|${ts}|${ct}`,
  );
}

/**
 * Encrypt one message for `to`.
 *
 * `recipientX25519Pub` must come from a bundle that passed
 * verifyPublicKeyBundle(); the caller is expected to check that.
 */
export function sealMessage({ seed32, chatIdentity, from, to, recipientX25519Pub, text, ts = Date.now() }) {
  const body = String(text ?? '');
  if (!body.trim()) throw new Error('A message needs some text.');
  if (body.length > MAX_TEXT_LENGTH) {
    throw new Error(`A message is limited to ${MAX_TEXT_LENGTH} characters.`);
  }
  if (!(recipientX25519Pub instanceof Uint8Array) || recipientX25519Pub.length !== 32) {
    throw new Error('The recipient has no usable messaging key.');
  }
  if (chatIdentity) {
    return sealChatMessage({ chatIdentity, from, to, recipientX25519Pub, body, ts });
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

function sealChatMessage({ chatIdentity, from, to, recipientX25519Pub, body, ts }) {
  const owner = String(chatIdentity?.address || '').toUpperCase();
  if (!chatIdentity?.seed32 || String(from || '').toUpperCase() !== owner) {
    throw new Error('The chat identity does not match the sender address.');
  }
  if (!chatIdentity.chatPub || !chatIdentity.delegation) {
    throw new Error('The chat identity is not registered for this wallet.');
  }
  if (!verifyChatDelegation({ address: owner, chatPub: chatIdentity.chatPub, delegation: chatIdentity.delegation })) {
    throw new Error('The chat identity is not authorized by this wallet.');
  }
  const ephemeral = nacl.box.keyPair();
  const nonce = nacl.randomBytes(24);
  const ciphertext = nacl.box(
    TEXT_ENCODER.encode(JSON.stringify({ v: CHAT_IDENTITY_VERSION, text: body })),
    nonce,
    recipientX25519Pub,
    ephemeral.secretKey,
  );
  wipe(ephemeral.secretKey);
  const fields = {
    from: owner,
    fromChat: chatIdentity.chatPub,
    fromDelegation: chatIdentity.delegation,
    to: String(to || '').toUpperCase(),
    ephPub: b64(ephemeral.publicKey),
    nonce: b64(nonce),
    ts: Number(ts),
    ct: b64(ciphertext),
  };
  const chat = signingKeyFromSeed(chatIdentity.seed32);
  const sig = nacl.sign.detached(chatEnvelopeBody(fields), chat.secretKey);
  wipe(chat.secretKey);
  return { v: CHAT_IDENTITY_VERSION, ...fields, sig: b64(sig) };
}

/**
 * Verify and decrypt one envelope addressed to `address`.
 *
 * Throws with a plain reason when the envelope is not for this wallet, was
 * altered, or was not signed by the address it claims to come from.
 */
export function openMessage({ seed32, chatIdentity, address, envelope }) {
  if (!envelope) throw new Error('Unsupported message format.');
  if (envelope.v !== E2E_VERSION && envelope.v !== CHAT_IDENTITY_VERSION) {
    throw new Error('Unsupported message format.');
  }
  const mine = String(address || '').toUpperCase();
  if (String(envelope.to || '').toUpperCase() !== mine) {
    throw new Error('This message is not addressed to this wallet.');
  }
  const from = String(envelope.from || '').toUpperCase();
  if (!/^G[A-Z2-7]{55}$/.test(from)) throw new Error('The sender address is not valid.');

  if (envelope.v === CHAT_IDENTITY_VERSION) {
    // A v2 bundle normally means the recipient has a delegated chat identity,
    // but a legacy recipient may still publish only its wallet key. In that
    // case the sender encrypts to that wallet key, so try both the delegated
    // key and the wallet key. The sender's delegation and signature are checked
    // before either key is used.
    const decryptSeeds = [chatIdentity?.seed32, seed32]
      .filter((candidate) => candidate instanceof Uint8Array && candidate.length === 32);
    if (decryptSeeds.length === 0) throw new Error('The chat identity is not available on this device.');
    const fromChat = String(envelope.fromChat || '');
    if (!verifyChatDelegation({
      address: from, chatPub: fromChat, delegation: envelope.fromDelegation,
    })) throw new Error('The message sender is not authorized by this wallet.');
    const body = chatEnvelopeBody({
      from,
      fromChat,
      fromDelegation: envelope.fromDelegation,
      to: String(envelope.to).toUpperCase(),
      ephPub: envelope.ephPub,
      nonce: envelope.nonce,
      ts: envelope.ts,
      ct: envelope.ct,
    });
    if (!nacl.sign.detached.verify(body, unb64(envelope.sig), unb64(fromChat))) {
      throw new Error('The message signature does not match its sender.');
    }
    const ephPub = unb64(envelope.ephPub);
    const nonce = unb64(envelope.nonce);
    if (ephPub.length !== 32 || nonce.length !== 24) throw new Error('The message is malformed.');
    let plaintext = null;
    for (const candidate of decryptSeeds) {
      const { secretKey } = x25519KeyPairFromSeed(candidate);
      plaintext = nacl.box.open(unb64(envelope.ct), nonce, ephPub, secretKey);
      wipe(secretKey);
      if (plaintext) break;
    }
    if (!plaintext) throw new Error('This message cannot be decrypted by this wallet or chat identity.');
    let parsed;
    try { parsed = JSON.parse(TEXT_DECODER.decode(plaintext)); } catch {
      throw new Error('The message body is not readable.');
    } finally { wipe(plaintext); }
    if (!parsed || parsed.v !== CHAT_IDENTITY_VERSION || typeof parsed.text !== 'string') {
      throw new Error('The message body is not readable.');
    }
    return { from, to: mine, ts: Number(envelope.ts), text: parsed.text };
  }
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
