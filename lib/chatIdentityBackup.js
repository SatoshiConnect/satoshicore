// Encrypted recovery record for a device chat identity.
//
// The chat identity is separate from the wallet seed, so losing browser storage
// must not make the encrypted archive unrecoverable. This envelope is written
// to the same app-private Drive folder as the archive, but it is encrypted with
// a key derived from the wallet seed. Restoring therefore needs the wallet
// password once; opening the chat afterwards still does not.
'use client';

import {
  CHAT_IDENTITY_VERSION, chatIdentityFromSeed, verifyChatDelegation,
} from './e2eChat.js';

export const CHAT_IDENTITY_BACKUP_APP = 'satoshicore-chat-identity';
export const CHAT_IDENTITY_BACKUP_VERSION = 1;
const AAD_PREFIX = 'nsc-chat-identity-backup|1';
const INFO = 'nsc-chat-identity-backup-key|1';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const b64 = (bytes) => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
};
const unb64 = (text) => Uint8Array.from(atob(String(text || '')), (c) => c.charCodeAt(0));

const aad = (address) => encoder.encode(`${AAD_PREFIX}|${address}`);

export function chatIdentityBackupFileName(address) {
  return `nsat-chat-identity.${String(address || '').toUpperCase()}.json`;
}

function assertOwner(address) {
  const owner = String(address || '').toUpperCase();
  if (!/^G[A-Z2-7]{55}$/.test(owner)) throw new Error('A chat key backup needs the wallet address it belongs to.');
  return owner;
}

function assertSeed(seed) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) {
    throw new Error('Unlock the wallet before backing up or restoring its chat key.');
  }
}

async function backupKey(walletSeed32, address) {
  assertSeed(walletSeed32);
  const material = await crypto.subtle.importKey('raw', walletSeed32, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode(address),
      info: encoder.encode(INFO),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Seal the private chat identity under the wallet seed for Drive recovery. */
export async function sealChatIdentityBackup({
  walletSeed32, address, identity, createdAt = new Date().toISOString(),
} = {}) {
  const owner = assertOwner(address);
  assertSeed(walletSeed32);
  if (!identity || String(identity.address || '').toUpperCase() !== owner) {
    throw new Error('That chat identity does not belong to this wallet.');
  }
  if (!(identity.seed32 instanceof Uint8Array) || identity.seed32.length !== 32) {
    throw new Error('This device has no chat identity to back up.');
  }
  const derived = chatIdentityFromSeed({
    seed32: identity.seed32, address: owner, delegation: identity.delegation,
  });
  if (derived.chatPub !== identity.chatPub) {
    throw new Error('The chat identity private key does not match its public key.');
  }
  if (!verifyChatDelegation({
    address: owner, chatPub: identity.chatPub, delegation: identity.delegation,
  })) {
    throw new Error('The chat identity delegation is not valid for this wallet.');
  }
  const key = await backupKey(walletSeed32, owner);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = JSON.stringify({
    seed32: b64(identity.seed32),
    delegation: identity.delegation,
    legacyX25519Pub: String(identity.legacyX25519Pub || ''),
  });
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(owner) },
    key,
    encoder.encode(payload),
  );
  return JSON.stringify({
    app: CHAT_IDENTITY_BACKUP_APP,
    v: CHAT_IDENTITY_BACKUP_VERSION,
    address: owner,
    chatPub: identity.chatPub,
    createdAt,
    iv: b64(iv),
    ct: b64(new Uint8Array(sealed)),
  });
}

/** Open a recovery record only with the matching wallet seed and address. */
export async function openChatIdentityBackup({ walletSeed32, address, text } = {}) {
  const owner = assertOwner(address);
  assertSeed(walletSeed32);
  let parsed;
  try {
    parsed = JSON.parse(String(text || ''));
  } catch {
    throw Object.assign(new Error('That file is not a chat key backup.'), { code: 'CHAT_IDENTITY_BAD_FILE' });
  }
  if (!parsed || parsed.app !== CHAT_IDENTITY_BACKUP_APP) {
    throw Object.assign(new Error('That file is not a chat key backup.'), { code: 'CHAT_IDENTITY_BAD_FILE' });
  }
  if (parsed.v !== CHAT_IDENTITY_BACKUP_VERSION) {
    throw Object.assign(new Error('That chat key backup was written by a newer version of this wallet.'), { code: 'CHAT_IDENTITY_BAD_VERSION' });
  }
  if (String(parsed.address || '').toUpperCase() !== owner) {
    throw Object.assign(new Error('That chat key backup belongs to a different wallet address.'), { code: 'CHAT_IDENTITY_OTHER_WALLET' });
  }
  const key = await backupKey(walletSeed32, owner);
  let opened;
  try {
    opened = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(parsed.iv), additionalData: aad(owner) },
      key,
      unb64(parsed.ct),
    );
  } catch {
    throw Object.assign(
      new Error('This wallet cannot open that chat key backup. It needs the same wallet seed that wrote it.'),
      { code: 'CHAT_IDENTITY_WRONG_KEY' },
    );
  }
  let payload;
  try {
    payload = JSON.parse(decoder.decode(opened));
  } catch {
    throw Object.assign(new Error('That chat key backup is damaged.'), { code: 'CHAT_IDENTITY_BAD_FILE' });
  }
  let seed32;
  try {
    seed32 = unb64(payload?.seed32);
  } catch {
    seed32 = null;
  }
  if (!(seed32 instanceof Uint8Array) || seed32.length !== 32
      || typeof payload?.delegation !== 'string' || !payload.delegation) {
    throw Object.assign(new Error('That chat key backup is damaged.'), { code: 'CHAT_IDENTITY_BAD_FILE' });
  }
  const identity = chatIdentityFromSeed({
    seed32, walletSeed32, address: owner, delegation: payload.delegation,
  });
  if (identity.chatPub !== parsed.chatPub || !verifyChatDelegation({
    address: owner, chatPub: identity.chatPub, delegation: identity.delegation,
  })) {
    throw Object.assign(new Error('That chat key backup does not match its wallet delegation.'), { code: 'CHAT_IDENTITY_BAD_FILE' });
  }
  identity.legacyX25519Pub = String(payload.legacyX25519Pub || identity.legacyX25519Pub || '');
  return identity;
}