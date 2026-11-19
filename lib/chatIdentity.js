// A device-local chat identity, separate from the wallet seed.
//
// The wallet seed is only used once, when this identity is created, to sign a
// delegation that binds the chat public key to the wallet address. After that
// the chat identity signs its own relay requests and owns its own X25519 key,
// so chat, the payment inbox and the archive keep working while the wallet is
// locked. Sending NSAT still uses the wallet password/passkey per transaction.
//
// The private half lives in browser storage, like a messaging session. It is
// not the wallet seed and cannot sign a transaction. Clearing site data loses
// the chat identity; a new one can be created on the next wallet unlock, but
// messages encrypted to the old identity cannot be recovered without it.
'use client';

import nacl from 'tweetnacl';
import {
  CHAT_IDENTITY_VERSION, chatIdentityFromSeed, signChatDelegation, verifyChatDelegation,
  x25519KeyPairFromSeed,
} from './e2eChat.js';

export const CHAT_IDENTITY_KEY = 'scw-chat-identity-v1';
export const CHAT_IDENTITY_MIGRATION_KEY = 'scw-chat-identity-migrated-v1';
export const CHAT_IDENTITY_LOCK_PREFIX = 'scw-chat-identity-v1:';

const storageOf = (storage) => {
  if (storage) return storage;
  return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
};

const b64 = (bytes) => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
};

const unb64 = (text) => Uint8Array.from(atob(String(text || '')), (c) => c.charCodeAt(0));

const browserLocks = () => {
  try {
    return typeof navigator === 'undefined' ? null : (navigator.locks || null);
  } catch {
    return null;
  }
};

export function chatIdentityStorageKey(address) {
  return `${CHAT_IDENTITY_KEY}:${String(address || '').toUpperCase()}`;
}

export function chatIdentityMigrationKey(address) {
  return `${CHAT_IDENTITY_MIGRATION_KEY}:${String(address || '').toUpperCase()}`;
}

function parseIdentity(raw, owner) {
  try {
    const parsed = JSON.parse(raw || 'null');
    if (!parsed || parsed.v !== CHAT_IDENTITY_VERSION) return null;
    if (String(parsed.address || '').toUpperCase() !== owner) return null;
    const seed32 = unb64(parsed.seed32);
    if (seed32.length !== 32) return null;
    const chat = nacl.sign.keyPair.fromSeed(seed32);
    const chatPub = b64(chat.publicKey);
    if (chatPub !== parsed.chatPub) return null;
    if (!verifyChatDelegation({
      address: owner, chatPub, delegation: parsed.delegation,
    })) return null;
    const identity = chatIdentityFromSeed({
      seed32, address: owner, delegation: parsed.delegation,
    });
    identity.legacyX25519Pub = String(parsed.legacyX25519Pub || '');
    return identity;
  } catch {
    return null;
  }
}

/** Read a previously created identity. Returns null when it is absent or bad. */
export function readChatIdentity(address, storage = undefined) {
  const owner = String(address || '').toUpperCase();
  if (!/^G[A-Z2-7]{55}$/.test(owner)) return null;
  const store = storageOf(storage);
  if (!store) return null;
  try {
    return parseIdentity(store.getItem(chatIdentityStorageKey(owner)), owner);
  } catch {
    return null;
  }
}

export function saveChatIdentity(identity, storage = undefined) {
  const owner = String(identity?.address || '').toUpperCase();
  const store = storageOf(storage);
  if (!store || !owner || !identity?.seed32 || !identity?.delegation) return false;
  try {
    store.setItem(chatIdentityStorageKey(owner), JSON.stringify({
      v: CHAT_IDENTITY_VERSION,
      address: owner,
      seed32: b64(identity.seed32),
      chatPub: identity.chatPub,
      legacyX25519Pub: identity.legacyX25519Pub || '',
      delegation: identity.delegation,
    }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Load the stored identity, or create it once when the wallet is unlocked.
 * Without a wallet seed this returns null, so chat stays unavailable until the
 * one-time setup/migration can run.
 */
export function ensureChatIdentity({ address, walletSeed32 = null, storage = undefined } = {}) {
  const owner = String(address || '').toUpperCase();
  if (!/^G[A-Z2-7]{55}$/.test(owner)) return null;
  const existing = readChatIdentity(owner, storage);
  if (existing) {
    if (!existing.legacyX25519Pub && walletSeed32 instanceof Uint8Array
        && walletSeed32.length === 32) {
      existing.legacyX25519Pub = b64(x25519KeyPairFromSeed(walletSeed32).publicKey);
      saveChatIdentity(existing, storage);
    }
    return existing;
  }
  if (!(walletSeed32 instanceof Uint8Array) || walletSeed32.length !== 32) return null;

  const seed32 = new Uint8Array(32);
  globalThis.crypto.getRandomValues(seed32);
  const chat = nacl.sign.keyPair.fromSeed(seed32);
  const chatPub = b64(chat.publicKey);
  try {
    const delegation = signChatDelegation({ walletSeed32, address: owner, chatPub });
    const identity = chatIdentityFromSeed({
      seed32, walletSeed32, address: owner, delegation,
    });
    if (!saveChatIdentity(identity, storage)) return null;
    return identity;
  } catch {
    return null;
  }
}

/**
 * Create the identity once even when several tabs unlock the same wallet at
 * the same time. Web Locks serialises the read/create/write sequence; the
 * second tab then adopts the key the first one stored instead of replacing it
 * with a different identity that would orphan messages already published.
 *
 * Without Web Locks this falls back to the synchronous path, which is still
 * safe for one tab and remains the compatibility path for older browsers.
 */
export async function ensureChatIdentityAcrossTabs({
  address, walletSeed32 = null, storage = undefined, locks = undefined,
} = {}) {
  const owner = String(address || '').toUpperCase();
  if (!/^G[A-Z2-7]{55}$/.test(owner)) return null;
  const existing = readChatIdentity(owner, storage);
  if (existing) return ensureChatIdentity({ address: owner, walletSeed32, storage });
  if (!(walletSeed32 instanceof Uint8Array) || walletSeed32.length !== 32) return null;

  const lockApi = locks === undefined ? browserLocks() : locks;
  if (!lockApi || typeof lockApi.request !== 'function') {
    return ensureChatIdentity({ address: owner, walletSeed32, storage });
  }
  try {
    return await lockApi.request(`${CHAT_IDENTITY_LOCK_PREFIX}${owner}`, async () => (
      ensureChatIdentity({ address: owner, walletSeed32, storage })
    ));
  } catch {
    // A blocked lock API must not make chat unusable; the storage read still
    // protects the common case and the caller can retry on the next render.
    return ensureChatIdentity({ address: owner, walletSeed32, storage });
  }
}

export function isChatIdentityCurrent(identity, address) {
  return Boolean(identity
    && String(identity.address || '').toUpperCase() === String(address || '').toUpperCase()
    && identity.seed32 instanceof Uint8Array
    && identity.seed32.length === 32
    && verifyChatDelegation({
      address: identity.address, chatPub: identity.chatPub, delegation: identity.delegation,
    }));
}

export function markChatMigrationDone(address, storage = undefined) {
  const store = storageOf(storage);
  try { store?.setItem(chatIdentityMigrationKey(address), '1'); } catch { /* private mode */ }
}

export function chatMigrationDone(address, storage = undefined) {
  const store = storageOf(storage);
  try { return store?.getItem(chatIdentityMigrationKey(address)) === '1'; } catch { return false; }
}
