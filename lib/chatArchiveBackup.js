// Encrypted container for the Drive copy of a chat archive.
//
// The rows inside are already sealed per message (lib/chatArchive.js). This
// wraps them a second time so Google Drive cannot even read the peer list or
// the timestamps: the only readable parts of the file are the app marker, the
// version, the wallet address it belongs to and the creation time, which are
// needed to find the right file after a restore.
'use client';

export const ARCHIVE_BACKUP_APP = 'satoshicore-chat-archive';
export const ARCHIVE_BACKUP_VERSION = 1;
const AAD_PREFIX = 'nsc-archive-backup|1';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const b64 = (bytes) => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
};
const unb64 = (text) => Uint8Array.from(atob(String(text || '')), (c) => c.charCodeAt(0));

const aad = (address) => encoder.encode(`${AAD_PREFIX}|${address}`);

/** One file per wallet: a shared account can hold several wallets. */
export function archiveBackupFileName(address) {
  return `nsat-chat-archive.${String(address || '').toUpperCase()}.json`;
}

/**
 * Seal the raw (already per-message encrypted) rows into one uploadable string.
 * `key` is the wallet's archive key, so restoring needs the same seed.
 */
export async function sealArchiveBackup(key, { address, rows, createdAt = new Date().toISOString() }) {
  const owner = String(address || '').toUpperCase();
  if (!/^G[A-Z2-7]{55}$/.test(owner)) throw new Error('A chat backup needs the wallet address it belongs to.');
  const payload = (Array.isArray(rows) ? rows : [])
    .filter((row) => row && row.id && row.peer && row.iv && row.ct)
    .map((row) => ({
      id: row.id,
      peer: row.peer,
      at: Number.isFinite(row.at) ? row.at : 0,
      iv: row.iv,
      ct: row.ct,
    }));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(owner) },
    key,
    encoder.encode(JSON.stringify(payload)),
  );
  return JSON.stringify({
    app: ARCHIVE_BACKUP_APP,
    v: ARCHIVE_BACKUP_VERSION,
    address: owner,
    createdAt,
    count: payload.length,
    iv: b64(iv),
    ct: b64(new Uint8Array(sealed)),
  });
}

/**
 * Open a downloaded backup. Refuses a file for another wallet, a newer version,
 * or one this seed cannot decrypt — all three are reported, never guessed.
 */
export async function openArchiveBackup(key, text, { address } = {}) {
  const owner = String(address || '').toUpperCase();
  let parsed;
  try {
    parsed = JSON.parse(String(text || ''));
  } catch {
    throw Object.assign(new Error('That file is not a chat history backup.'), { code: 'ARCHIVE_BAD_FILE' });
  }
  if (!parsed || parsed.app !== ARCHIVE_BACKUP_APP) {
    throw Object.assign(new Error('That file is not a chat history backup.'), { code: 'ARCHIVE_BAD_FILE' });
  }
  if (parsed.v !== ARCHIVE_BACKUP_VERSION) {
    throw Object.assign(new Error('That chat backup was written by a newer version of this wallet.'), { code: 'ARCHIVE_BAD_VERSION' });
  }
  if (String(parsed.address || '').toUpperCase() !== owner) {
    throw Object.assign(new Error('That chat backup belongs to a different wallet address.'), { code: 'ARCHIVE_OTHER_WALLET' });
  }
  let opened;
  try {
    opened = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(parsed.iv), additionalData: aad(owner) },
      key,
      unb64(parsed.ct),
    );
  } catch {
    throw Object.assign(
      new Error('This wallet cannot open that chat backup. It needs the same seed that wrote it.'),
      { code: 'ARCHIVE_WRONG_KEY' },
    );
  }
  let rows;
  try {
    rows = JSON.parse(decoder.decode(opened));
  } catch {
    throw Object.assign(new Error('That chat backup is damaged.'), { code: 'ARCHIVE_BAD_FILE' });
  }
  if (!Array.isArray(rows)) {
    throw Object.assign(new Error('That chat backup is damaged.'), { code: 'ARCHIVE_BAD_FILE' });
  }
  const clean = rows.filter((row) => row && typeof row.id === 'string' && typeof row.peer === 'string'
    && typeof row.iv === 'string' && typeof row.ct === 'string');
  return { rows: clean, createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '', count: clean.length };
}
