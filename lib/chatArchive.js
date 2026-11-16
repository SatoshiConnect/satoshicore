// Opt-in encrypted transcript archive on this device.
//
// SECURITY MODEL (also docs/CHAT-ARCHIVE.md):
//  - Off by default. Nothing is written unless the person turns it on, because
//    the messenger's original rule is that losing the tab loses the transcript.
//  - The archive key is derived from the wallet seed with HKDF-SHA256, bound to
//    the wallet address. It is never stored: no password, no extra secret, no
//    key export. Whoever has the seed can read the archive — that is the same
//    assumption the chat itself makes.
//  - Each message body is AES-256-GCM with a fresh IV and additional data that
//    binds the record to its wallet, peer, message id and timestamp, so a row
//    cannot be moved to another conversation or replayed under another wallet.
//  - The row keeps three things in clear so the list can be read without the
//    key: the wallet address, the peer address and the timestamp. That is
//    metadata the relay already sees; the text never is.
//  - Wiping on lock is a convenience, not a guarantee: storage is copy-on-write,
//    so a deleted row may survive on the disk until it is overwritten.
'use client';

export const ARCHIVE_DB = 'scw-chat-archive-v1';
export const ARCHIVE_PREFS_KEY = 'scw-chat-archive-prefs-v1';
export const ARCHIVE_VERSION = 2;
const STORE = 'messages';
export const REQUESTS_STORE = 'requests';
const KEY_INFO = 'nsc-chat-archive-v1';
const AAD_PREFIX = 'nsc-archive|1';

export const DEFAULT_ARCHIVE_PREFS = Object.freeze({
  enabled: false,
  wipeOnLock: false,
  lastBackupAt: '',
});

function storageOf(storage) {
  if (storage) return storage;
  return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
}

/** Read the device preferences; anything missing or unreadable means "off". */
export function readArchivePrefs(storage = undefined) {
  const store = storageOf(storage);
  if (!store) return { ...DEFAULT_ARCHIVE_PREFS };
  try {
    const parsed = JSON.parse(store.getItem(ARCHIVE_PREFS_KEY) || 'null');
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_ARCHIVE_PREFS };
    return {
      enabled: parsed.enabled === true,
      wipeOnLock: parsed.enabled === true && parsed.wipeOnLock === true,
      lastBackupAt: typeof parsed.lastBackupAt === 'string' ? parsed.lastBackupAt : '',
    };
  } catch {
    return { ...DEFAULT_ARCHIVE_PREFS };
  }
}

/** Merge a change into the stored preferences and return the new value. */
export function writeArchivePrefs(patch, storage = undefined) {
  const next = { ...readArchivePrefs(storage), ...(patch || {}) };
  if (!next.enabled) next.wipeOnLock = false;
  const store = storageOf(storage);
  if (store) {
    try { store.setItem(ARCHIVE_PREFS_KEY, JSON.stringify(next)); } catch { /* quota/private mode: stay off */ }
  }
  return next;
}

// ---------------- key derivation ----------------

const encoder = new TextEncoder();
// owner → { fingerprint, key }. The fingerprint keeps a cached key from being
// reused when the same address is presented with a different seed (a replaced
// or re-imported wallet); it is a truncated SHA-256, never the seed itself.
const keyCache = new Map();

async function seedFingerprint(seed32) {
  const digest = await crypto.subtle.digest('SHA-256', seed32);
  return new Uint8Array(digest).slice(0, 8).join(',');
}

const b64 = (bytes) => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
};
const unb64 = (text) => Uint8Array.from(atob(String(text || '')), (c) => c.charCodeAt(0));

/**
 * The archive key for one wallet: HKDF-SHA256 over the seed, salted with the
 * wallet address so two wallets can never share a key even if a caller mixes
 * them up. Cached in memory for the session; `forgetArchiveKeys()` drops it.
 */
export async function deriveArchiveKey(seed32, address) {
  const owner = String(address || '').toUpperCase();
  if (!(seed32 instanceof Uint8Array) || seed32.length !== 32) {
    throw new Error('Unlock the wallet before opening saved chat history.');
  }
  if (!/^G[A-Z2-7]{55}$/.test(owner)) throw new Error('Saved chat history needs a wallet address.');
  const fingerprint = await seedFingerprint(seed32);
  const cached = keyCache.get(owner);
  if (cached && cached.fingerprint === fingerprint) return cached.key;
  const material = await crypto.subtle.importKey('raw', seed32, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(owner), info: encoder.encode(KEY_INFO) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  keyCache.set(owner, { fingerprint, key });
  return key;
}

/** Drop every derived archive key. Called on lock, before the seed is zeroed. */
export function forgetArchiveKeys() {
  keyCache.clear();
}

// ---------------- record crypto (pure) ----------------

export function archiveAad({ address, peer, id, at }) {
  return encoder.encode(`${AAD_PREFIX}|${String(address).toUpperCase()}|${peer}|${id}|${at}`);
}

/** Encrypt one transcript line: { iv, ct } in base64. */
export async function sealArchiveText(key, { address, peer, id, at, own, text }) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = encoder.encode(JSON.stringify({ own: own === true, text: String(text ?? '') }));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: archiveAad({ address, peer, id, at }) },
    key,
    body,
  );
  return { iv: b64(iv), ct: b64(new Uint8Array(sealed)) };
}

/** Decrypt one row; returns null when the row does not belong or was tampered with. */
export async function openArchiveText(key, { address, peer, id, at, iv, ct }) {
  try {
    const opened = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(iv), additionalData: archiveAad({ address, peer, id, at }) },
      key,
      unb64(ct),
    );
    const parsed = JSON.parse(new TextDecoder().decode(opened));
    if (!parsed || typeof parsed.text !== 'string') return null;
    return { own: parsed.own === true, text: parsed.text };
  } catch {
    return null;
  }
}

// ---------------- IndexedDB ----------------

const available = () => typeof indexedDB !== 'undefined';

/** Open the one archive database that holds transcripts and payment requests. */
export function openArchiveDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ARCHIVE_DB, ARCHIVE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('owner_peer', ['owner', 'peer']);
        store.createIndex('owner', 'owner');
      }
      // v2 adds the payment-request ledger. Keeping it in the same database
      // means one key derivation and one place to wipe; transcripts remain in
      // their own store so existing archive code is unchanged.
      if (!db.objectStoreNames.contains(REQUESTS_STORE)) {
        const requests = db.createObjectStore(REQUESTS_STORE, { keyPath: 'key' });
        requests.createIndex('owner', 'owner');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open the chat archive.'));
  });
}

const openDb = openArchiveDb;

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('The chat archive write failed.'));
    tx.onabort = () => reject(tx.error || new Error('The chat archive write was aborted.'));
  });
}

const rowKey = (owner, peer, id) => `${owner}|${peer}|${id}`;

/**
 * Append lines for one conversation. Idempotent: the same message id is stored
 * once, so a re-read from the relay cannot duplicate the transcript.
 */
export async function archiveMessages({ seed32, address, peer, messages }) {
  if (!available() || !peer || !Array.isArray(messages) || messages.length === 0) return 0;
  const owner = String(address || '').toUpperCase();
  const key = await deriveArchiveKey(seed32, owner);
  const rows = [];
  for (const message of messages) {
    if (!message || !message.id || typeof message.text !== 'string' || !message.text) continue;
    const at = Number.isFinite(message.at) ? message.at : Date.now();
    const sealed = await sealArchiveText(key, {
      address: owner, peer, id: message.id, at, own: message.own, text: message.text,
    });
    rows.push({ key: rowKey(owner, peer, message.id), owner, peer, id: message.id, at, ...sealed });
  }
  if (rows.length === 0) return 0;
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const row of rows) store.put(row);
    await done(tx);
    return rows.length;
  } finally {
    db.close();
  }
}

/** Decrypted transcript for one conversation, oldest first. */
export async function readArchivedThread({ seed32, address, peer, limit = 500 }) {
  if (!available() || !peer) return [];
  const owner = String(address || '').toUpperCase();
  const key = await deriveArchiveKey(seed32, owner);
  const db = await openDb();
  let rows = [];
  try {
    rows = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).index('owner_peer').getAll([owner, peer]);
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
  // Index order is by key, not by time; keep the newest `limit` lines by stamp.
  const opened = [];
  for (const row of rows.sort((a, b) => (a.at || 0) - (b.at || 0)).slice(-limit)) {
    const body = await openArchiveText(key, { ...row, address: owner });
    if (!body) continue;
    opened.push({
      id: row.id,
      peer,
      from: body.own ? owner : peer,
      text: body.text,
      at: row.at,
      own: body.own,
    });
  }
  return opened.sort((a, b) => (a.at || 0) - (b.at || 0));
}

/** Raw rows (still encrypted) — used by the Drive backup, never rendered. */
export async function readArchivedRows(address) {
  if (!available()) return [];
  const owner = String(address || '').toUpperCase();
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).index('owner').getAll(owner);
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/** Put already-encrypted rows back (restore from Drive). Idempotent by key. */
export async function restoreArchivedRows(address, rows) {
  if (!available() || !Array.isArray(rows) || rows.length === 0) return 0;
  const owner = String(address || '').toUpperCase();
  const cleaned = rows.filter((row) => row && row.id && row.peer && row.iv && row.ct);
  if (cleaned.length === 0) return 0;
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const row of cleaned) {
      store.put({
        key: rowKey(owner, row.peer, row.id),
        owner,
        peer: row.peer,
        id: row.id,
        at: Number.isFinite(row.at) ? row.at : 0,
        iv: row.iv,
        ct: row.ct,
      });
    }
    await done(tx);
    return cleaned.length;
  } finally {
    db.close();
  }
}

/** How many lines are stored for one wallet (readable while locked). */
export async function countArchivedMessages(address) {
  if (!available() || !address) return 0;
  const owner = String(address).toUpperCase();
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).index('owner').count(IDBKeyRange.only(owner));
      request.onsuccess = () => resolve(request.result || 0);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/** Delete one wallet's transcript archive; the payment-request ledger is separate. */
export async function clearArchivedWallet(address) {
  if (!available() || !address) return;
  const owner = String(address).toUpperCase();
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const cursor = store.index('owner').openCursor(IDBKeyRange.only(owner));
    cursor.onsuccess = () => {
      const found = cursor.result;
      if (!found) return;
      found.delete();
      found.continue();
    };
    await done(tx);
  } finally {
    db.close();
  }
}

/** Delete every wallet's archive on this device. */
export async function clearAllArchives() {
  if (!available()) return;
  const db = await openDb();
  try {
    const tx = db.transaction([STORE, REQUESTS_STORE], 'readwrite');
    tx.objectStore(STORE).clear();
    tx.objectStore(REQUESTS_STORE).clear();
    await done(tx);
  } finally {
    db.close();
  }
}
