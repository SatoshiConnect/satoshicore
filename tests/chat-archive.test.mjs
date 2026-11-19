import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_ARCHIVE_PREFS, archiveAad, deriveArchiveKey, openArchiveText,
  readArchivePrefs, sealArchiveText, writeArchivePrefs,
} from '../lib/chatArchive.js';
import {
  ARCHIVE_BACKUP_APP, ARCHIVE_BACKUP_VERSION, archiveBackupFileName,
  openArchiveBackup, sealArchiveBackup,
} from '../lib/chatArchiveBackup.js';

const ADDRESS = `G${'A'.repeat(55)}`;
const OTHER = `G${'B'.repeat(55)}`;
const PEER = `G${'C'.repeat(55)}`;

// Two deterministic 32-byte seeds; the archive never sees anything else.
const SEED = new Uint8Array(32).fill(7);
const WRONG_SEED = new Uint8Array(32).fill(9);

const memoryStorage = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
};

const line = (overrides = {}) => ({
  address: ADDRESS, peer: PEER, id: 'm1', at: 1_794_800_000_000, own: true,
  text: 'hello archive — 1,000 NSAT', ...overrides,
});

test('archive preferences are opt-in and default to off', () => {
  const storage = memoryStorage();
  assert.deepEqual(readArchivePrefs(storage), { ...DEFAULT_ARCHIVE_PREFS });
  assert.equal(DEFAULT_ARCHIVE_PREFS.enabled, false);

  const on = writeArchivePrefs({ enabled: true, wipeOnLock: true }, storage);
  assert.deepEqual(on, { enabled: true, wipeOnLock: true, lastBackupAt: '' });
  assert.deepEqual(readArchivePrefs(storage), on);

  // Turning the archive off also drops the dependent wipe choice.
  const off = writeArchivePrefs({ enabled: false }, storage);
  assert.equal(off.enabled, false);
  assert.equal(off.wipeOnLock, false);

  // A corrupted record is treated as "off", never as "on".
  storage.setItem('scw-chat-archive-prefs-v1', '{not json');
  assert.deepEqual(readArchivePrefs(storage), { ...DEFAULT_ARCHIVE_PREFS });
});

test('archive key is derived from the seed plus the wallet address', async () => {
  const key = await deriveArchiveKey(SEED, ADDRESS);
  const same = await deriveArchiveKey(SEED, ADDRESS);
  const otherWallet = await deriveArchiveKey(SEED, OTHER);

  const sealed = await sealArchiveText(key, line());
  assert.equal((await openArchiveText(same, line({ ...sealed }))).text, line().text);
  // Same seed, different address: HKDF salt differs, so the record is opaque.
  assert.equal(await openArchiveText(otherWallet, line({ ...sealed })), null);
});

test('the chat identity archive scope is separate from the legacy wallet scope', async () => {
  const legacy = await deriveArchiveKey(SEED, ADDRESS);
  const chat = await deriveArchiveKey(SEED, ADDRESS, 'chat');
  const sealed = await sealArchiveText(chat, line());

  assert.equal((await openArchiveText(legacy, line({ ...sealed }))), null);
  assert.equal((await openArchiveText(chat, line({ ...sealed }))).text, line().text);
});

test('a sealed line is bound to its wallet, peer, id and timestamp', async () => {
  const key = await deriveArchiveKey(SEED, ADDRESS);
  const sealed = await sealArchiveText(key, line());

  // Moving the ciphertext to another conversation must not decrypt.
  assert.equal(await openArchiveText(key, line({ ...sealed, peer: OTHER })), null);
  assert.equal(await openArchiveText(key, line({ ...sealed, id: 'm2' })), null);
  assert.equal(await openArchiveText(key, line({ ...sealed, at: 1 })), null);

  // Tampering with the body must not decrypt either.
  const bytes = Uint8Array.from(atob(sealed.ct), (c) => c.charCodeAt(0));
  bytes[0] ^= 0xff;
  const tampered = btoa(String.fromCharCode(...bytes));
  assert.equal(await openArchiveText(key, line({ ...sealed, ct: tampered })), null);
});

test('archive AAD names the wallet, conversation and message', () => {
  const text = new TextDecoder().decode(archiveAad(line()));
  assert.equal(text, `nsc-archive|1|${ADDRESS}|${PEER}|m1|1794800000000`);
});

test('Drive container round-trips the encrypted rows and keeps text out of the clear', async () => {
  const key = await deriveArchiveKey(SEED, ADDRESS);
  const sealed = await sealArchiveText(key, line());
  const rows = [{ key: 'k', owner: ADDRESS, id: 'm1', peer: PEER, at: line().at, ...sealed }];

  const file = await sealArchiveBackup(key, { address: ADDRESS, rows, createdAt: '2026-11-16T00:00:00.000Z' });
  const parsed = JSON.parse(file);
  assert.equal(parsed.app, ARCHIVE_BACKUP_APP);
  assert.equal(parsed.v, ARCHIVE_BACKUP_VERSION);
  assert.equal(parsed.address, ADDRESS);
  assert.equal(parsed.count, 1);
  assert.equal(file.includes(line().text), false, 'plaintext must not reach the Drive file');
  assert.equal(file.includes(PEER), false, 'peer addresses stay inside the sealed container');

  const opened = await openArchiveBackup(key, file, { address: ADDRESS });
  assert.equal(opened.count, 1);
  assert.deepEqual(opened.rows, [{ id: 'm1', peer: PEER, at: line().at, iv: sealed.iv, ct: sealed.ct }]);
  // The restored row opens to the original text.
  assert.equal((await openArchiveText(key, { ...opened.rows[0], address: ADDRESS })).text, line().text);
});

test('a backup refuses another wallet, a wrong seed, a newer version or a foreign file', async () => {
  const key = await deriveArchiveKey(SEED, ADDRESS);
  const sealed = await sealArchiveText(key, line());
  const file = await sealArchiveBackup(key, {
    address: ADDRESS, rows: [{ id: 'm1', peer: PEER, at: line().at, ...sealed }],
  });

  await assert.rejects(openArchiveBackup(key, file, { address: OTHER }), /different wallet/);
  await assert.rejects(
    openArchiveBackup(await deriveArchiveKey(WRONG_SEED, ADDRESS), file, { address: ADDRESS }),
    /same seed/,
  );
  await assert.rejects(
    openArchiveBackup(key, JSON.stringify({ app: ARCHIVE_BACKUP_APP, v: 99, address: ADDRESS }), { address: ADDRESS }),
    /newer version/,
  );
  await assert.rejects(openArchiveBackup(key, '{"app":"other"}', { address: ADDRESS }), /not a chat history backup/);
  await assert.rejects(openArchiveBackup(key, 'not json', { address: ADDRESS }), /not a chat history backup/);
});

test('backup file name is per wallet and uppercase', () => {
  assert.equal(archiveBackupFileName(ADDRESS.toLowerCase()), `nsat-chat-archive.${ADDRESS}.json`);
});
