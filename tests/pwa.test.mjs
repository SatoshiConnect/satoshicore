// Pure logic tests for the PWA convenience features; no real browser, storage
// contents, or network is needed.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatStorageBytes, readPwaStorage, requestPwaPersistence, storageUsagePercent,
} from '../lib/pwaStorage.js';
import { parseShareTarget, sharePageForShortcut, shareText } from '../lib/shareTarget.js';
import { consumeSharedContent, SHARE_MAX_AGE_MS, storeSharedContent } from '../lib/pwaShareInbox.js';

function fakeIndexedDb() {
  const rows = new Map();
  return {
    rows,
    open() {
      const req = { result: null };
      const db = {
        objectStoreNames: { contains: () => true }, createObjectStore: () => {}, close: () => {},
        transaction() {
          const tx = { oncomplete: null, onerror: null, onabort: null };
          tx.objectStore = () => ({
            put: (row) => rows.set(row.id, row),
            delete: (id) => rows.delete(id),
            getAll: () => {
              const all = { result: [] };
              setTimeout(() => { all.result = [...rows.values()]; all.onsuccess?.(); }, 0);
              return all;
            },
            get: (id) => {
              const item = { result: rows.get(id) || null };
              setTimeout(() => item.onsuccess?.(), 0);
              return item;
            },
          });
          setTimeout(() => tx.oncomplete?.(), 10);
          return tx;
        },
      };
      req.result = db;
      queueMicrotask(() => req.onsuccess?.());
      return req;
    },
  };
}

test('manifest shortcut values map only to known internal views', () => {
  assert.equal(sharePageForShortcut('chat'), 'chat');
  assert.equal(sharePageForShortcut('receive'), 'receive');
  assert.equal(sharePageForShortcut('wallet'), 'overview');
  assert.equal(sharePageForShortcut('https://evil.test'), null);
  assert.equal(sharePageForShortcut('../send'), null);
});

test('share data is bounded plain text; unsafe URL schemes are not links', () => {
  const parsed = parseShareTarget('?title=Hello&text=One+two&url=https%3A%2F%2Fexample.test%2Fpath');
  assert.deepEqual(parsed, {
    title: 'Hello',
    text: 'One two',
    url: 'https://example.test/path',
    safeUrl: 'https://example.test/path',
  });
  assert.equal(shareText(parsed), 'Hello\n\nOne two\n\nhttps://example.test/path');

  const bad = parseShareTarget('?url=javascript%3Aalert(1)');
  assert.equal(bad.url, 'javascript:alert(1)');
  assert.equal(bad.safeUrl, '');

  const long = parseShareTarget(`?title=${'x'.repeat(300)}&text=${'y'.repeat(6000)}&url=${'a'.repeat(3000)}`);
  assert.equal(long.title.length, 200);
  assert.equal(long.text.length, 5000);
  assert.equal(long.url.length, 2048);
  assert.equal(long.safeUrl, '');
});

test('share handoff is bounded, one-time, expires, and removes consumed local text', async () => {
  const indexedDB = fakeIndexedDb();
  let at = 1000;
  const cryptoImpl = { getRandomValues: (bytes) => { bytes.fill(0xab); return bytes; } };
  const id = await storeSharedContent({ title: 'Title', text: 'Shared text', url: 'https://example.test' }, {
    indexedDB, cryptoImpl, now: () => at,
  });
  assert.equal(id, 'ab'.repeat(16));
  assert.equal(indexedDB.rows.size, 1);
  assert.deepEqual(await consumeSharedContent(id, { indexedDB, now: () => at }), {
    title: 'Title', text: 'Shared text', url: 'https://example.test',
  });
  assert.equal(indexedDB.rows.size, 0);
  assert.equal(await consumeSharedContent(id, { indexedDB, now: () => at }), null);

  const expired = await storeSharedContent({ text: 'expires' }, { indexedDB, cryptoImpl, now: () => at });
  at += SHARE_MAX_AGE_MS + 1;
  assert.equal(await consumeSharedContent(expired, { indexedDB, now: () => at }), null);
  assert.equal(indexedDB.rows.has(expired), false);
});

test('storage estimate reports only browser metadata and formats units', async () => {
  const status = await readPwaStorage({
    estimate: async () => ({ usage: 1_572_864, quota: 10_485_760 }),
    persisted: async () => true,
    persist: async () => true,
  });
  assert.deepEqual(status, { supported: true, usage: 1_572_864, quota: 10_485_760, persisted: true });
  assert.equal(formatStorageBytes(0), '0 B');
  assert.equal(formatStorageBytes(1_572_864), '1.5 MB');
  assert.equal(formatStorageBytes(NaN), 'Unknown');
  assert.equal(storageUsagePercent(status), 15);
  assert.equal(storageUsagePercent({ usage: 10, quota: 0 }), null);
});

test('storage APIs degrade gracefully and persistence request is explicit', async () => {
  assert.deepEqual(await readPwaStorage({}), {
    supported: false, usage: null, quota: null, persisted: null,
  });
  let asked = 0;
  assert.equal(await requestPwaPersistence({
    persist: async () => { asked += 1; return true; },
  }), true);
  assert.equal(asked, 1);
  assert.equal(await requestPwaPersistence({}), false);
  assert.deepEqual(await readPwaStorage({
    estimate: async () => { throw new Error('unavailable'); },
  }), { supported: true, usage: null, quota: null, persisted: null });
});
