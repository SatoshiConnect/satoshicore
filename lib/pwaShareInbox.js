// Short-lived, one-time local handoff for text/link Web Share Target POSTs.
// No shared content reaches the server or Cache API. The page deletes the row
// immediately after loading it; a short TTL cleans up interrupted handoffs.
export const SHARE_DB_NAME = 'nsat-pwa-share-v1';
export const SHARE_STORE_NAME = 'inbox';
export const SHARE_MAX_AGE_MS = 5 * 60 * 1000;
export const SHARE_MAX_RECORDS = 10;

function openDb(indexedDB = globalThis.indexedDB) {
  if (!indexedDB?.open) return Promise.reject(new Error('IndexedDB is unavailable.'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SHARE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(SHARE_STORE_NAME)) {
        request.result.createObjectStore(SHARE_STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Share storage unavailable.'));
  });
}

function createId(cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.getRandomValues) throw new Error('Secure randomness unavailable.');
  const bytes = new Uint8Array(16);
  cryptoImpl.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function storeSharedContent(fields, {
  indexedDB = globalThis.indexedDB,
  cryptoImpl = globalThis.crypto,
  now = () => Date.now(),
} = {}) {
  const db = await openDb(indexedDB);
  const createdAt = now();
  const id = createId(cryptoImpl);
  const row = {
    id,
    createdAt,
    title: String(fields?.title || '').slice(0, 200),
    text: String(fields?.text || '').slice(0, 5000),
    url: String(fields?.url || '').slice(0, 2048),
  };
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SHARE_STORE_NAME, 'readwrite');
      const store = tx.objectStore(SHARE_STORE_NAME);
      const all = store.getAll();
      all.onsuccess = () => {
        const rows = (all.result || []).filter((item) => item.id !== id);
        for (const item of rows) {
          if (createdAt - Number(item.createdAt || 0) > SHARE_MAX_AGE_MS) store.delete(item.id);
        }
        const retained = rows
          .filter((item) => createdAt - Number(item.createdAt || 0) <= SHARE_MAX_AGE_MS)
          .sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
        for (const item of retained.slice(SHARE_MAX_RECORDS - 1)) store.delete(item.id);
        store.put(row);
      };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('Could not store shared content.'));
      tx.onabort = () => reject(tx.error || new Error('Could not store shared content.'));
    });
    return id;
  } finally {
    db.close();
  }
}

/** Atomically consume and remove the one-time record. */
export async function consumeSharedContent(id, {
  indexedDB = globalThis.indexedDB,
  now = () => Date.now(),
} = {}) {
  const key = String(id || '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(key)) return null;
  const db = await openDb(indexedDB);
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(SHARE_STORE_NAME, 'readwrite');
      const store = tx.objectStore(SHARE_STORE_NAME);
      const request = store.get(key);
      let result = null;
      request.onsuccess = () => {
        const row = request.result;
        if (row && now() - Number(row.createdAt || 0) <= SHARE_MAX_AGE_MS) {
          result = { title: row.title, text: row.text, url: row.url };
        }
        if (row) store.delete(key);
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error('Could not read shared content.'));
      tx.onabort = () => reject(tx.error || new Error('Could not read shared content.'));
    });
  } finally {
    db.close();
  }
}
