import assert from 'node:assert/strict';
import { test } from 'node:test';

import nacl from 'tweetnacl';
import { encodeG } from '../lib/nsatCodec.js';
import { ensureChatIdentity } from '../lib/chatIdentity.js';
import {
  CHAT_IDENTITY_BACKUP_APP, CHAT_IDENTITY_BACKUP_VERSION, chatIdentityBackupFileName,
  openChatIdentityBackup, sealChatIdentityBackup,
} from '../lib/chatIdentityBackup.js';

const WALLET_SEED = new Uint8Array(32).fill(19);
const WRONG_SEED = new Uint8Array(32).fill(29);
const ADDRESS = encodeG(nacl.sign.keyPair.fromSeed(WALLET_SEED).publicKey);
const OTHER = encodeG(nacl.sign.keyPair.fromSeed(WRONG_SEED).publicKey);

const memoryStorage = () => {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
};

const identity = () => ensureChatIdentity({
  address: ADDRESS, walletSeed32: WALLET_SEED, storage: memoryStorage(),
});

test('a chat identity backup round-trips only with its wallet seed and address', async () => {
  const created = identity();
  const text = await sealChatIdentityBackup({
    walletSeed32: WALLET_SEED,
    address: ADDRESS,
    identity: created,
    createdAt: '2026-11-16T00:00:00.000Z',
  });
  const parsed = JSON.parse(text);
  assert.equal(parsed.app, CHAT_IDENTITY_BACKUP_APP);
  assert.equal(parsed.v, CHAT_IDENTITY_BACKUP_VERSION);
  assert.equal(parsed.address, ADDRESS);
  assert.equal(parsed.chatPub, created.chatPub);
  assert.equal(text.includes(created.seed32.toString()), false);

  const opened = await openChatIdentityBackup({ walletSeed32: WALLET_SEED, address: ADDRESS, text });
  assert.equal(opened.chatPub, created.chatPub);
  assert.equal(opened.delegation, created.delegation);
  assert.deepEqual(opened.seed32, created.seed32);
  assert.equal(opened.legacyX25519Pub, created.legacyX25519Pub);

  await assert.rejects(
    openChatIdentityBackup({ walletSeed32: WRONG_SEED, address: OTHER, text }),
    (error) => error.code === 'CHAT_IDENTITY_OTHER_WALLET',
  );
  await assert.rejects(
    openChatIdentityBackup({ walletSeed32: WRONG_SEED, address: ADDRESS, text }),
    (error) => error.code === 'CHAT_IDENTITY_WRONG_KEY',
  );
});

test('a tampered or mis-addressed chat identity backup is refused', async () => {
  const text = await sealChatIdentityBackup({
    walletSeed32: WALLET_SEED, address: ADDRESS, identity: identity(),
  });
  const parsed = JSON.parse(text);
  const bytes = Uint8Array.from(atob(parsed.ct), (c) => c.charCodeAt(0));
  bytes[0] ^= 0xff;
  parsed.ct = btoa(String.fromCharCode(...bytes));
  await assert.rejects(
    openChatIdentityBackup({ walletSeed32: WALLET_SEED, address: ADDRESS, text: JSON.stringify(parsed) }),
    (error) => error.code === 'CHAT_IDENTITY_WRONG_KEY',
  );

  await assert.rejects(
    openChatIdentityBackup({ walletSeed32: WALLET_SEED, address: ADDRESS, text: 'not json' }),
    (error) => error.code === 'CHAT_IDENTITY_BAD_FILE',
  );
  await assert.rejects(
    openChatIdentityBackup({
      walletSeed32: WALLET_SEED, address: ADDRESS,
      text: JSON.stringify({ app: CHAT_IDENTITY_BACKUP_APP, v: 99, address: ADDRESS }),
    }),
    (error) => error.code === 'CHAT_IDENTITY_BAD_VERSION',
  );
});

test('the recovery file is named per wallet address', () => {
  assert.equal(chatIdentityBackupFileName(ADDRESS.toLowerCase()), `nsat-chat-identity.${ADDRESS}.json`);
});