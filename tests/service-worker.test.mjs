// Behavioural test for the PWA service worker: offline shell, notification
// handling, and device-local share-target POSTs.
//
// The static-export suite checks that sw.js ships and that it *looks* right
// (string assertions). This file actually runs the worker's fetch handler in a
// fake service-worker global with a recording Cache API, so the security claim
// "chain state is never cached" is enforced by behaviour, not by grep.
//
// No browser and no network: every request is answered by a stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import { serviceWorkerRegistration } from '../lib/serviceWorkerRegistration.js';

// public/sw.js is the source of truth: the static export copies it verbatim, so
// testing the built copy would only prove that the last build happened.
const SW_PATH = join(process.cwd(), 'public', 'sw.js');
const ORIGIN = 'https://satoshicore.org';
// Read the cache name from the worker itself, so bumping VERSION never makes
// this behavioural test assert against a cache the worker no longer uses.
const VERSION = readFileSync(SW_PATH, 'utf8')
  .match(/const VERSION = '([^']+)'/)?.[1];

function loadWorker() {
  const source = readFileSync(SW_PATH, 'utf8');
  const listeners = new Map();
  const cacheContents = new Map();   // cacheName -> Map(url -> Response)
  const fetchLog = [];

  const makeCache = (name) => {
    if (!cacheContents.has(name)) cacheContents.set(name, new Map());
    const store = cacheContents.get(name);
    return {
      async add(request) { store.set(request.url, new Response('cached', { status: 200 })); },
      async put(request, response) { store.set(request.url, response); },
      async match(request) {
        const url = typeof request === 'string' ? request : request.url;
        return store.get(url) || undefined;
      },
      async keys() { return [...store.keys()].map((url) => ({ url })); },
      async delete(request) {
        const url = typeof request === 'string' ? request : request.url;
        return store.delete(url);
      },
    };
  };

  const caches = {
    async open(name) { return makeCache(name); },
    async keys() { return [...cacheContents.keys()]; },
    async delete(name) { return cacheContents.delete(name); },
    async match(request) {
      const url = typeof request === 'string' ? request : request.url;
      for (const store of cacheContents.values()) {
        if (store.has(url)) return store.get(url);
      }
      return undefined;
    },
  };

  const notifications = [];
  const windows = [];
  const opened = [];
  const shareRecords = new Map();
  const indexedDB = {
    open() {
      const request = { result: null };
      const db = {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => {},
        close: () => {},
        transaction() {
          const tx = { oncomplete: null, onerror: null, onabort: null };
          tx.objectStore = () => ({
            put: (row) => shareRecords.set(row.id, row),
            getAll: () => {
              const all = { result: [] };
              queueMicrotask(() => { all.result = [...shareRecords.values()]; all.onsuccess?.(); });
              return all;
            },
          });
          setTimeout(() => tx.oncomplete?.(), 0);
          return tx;
        },
      };
      request.result = db;
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  };
  const self = {
    location: { origin: ORIGIN },
    registration: {
      scope: `${ORIGIN}/`,
      showNotification: async (title, options) => { notifications.push({ title, options }); },
    },
    addEventListener: (type, fn) => listeners.set(type, fn),
    skipWaiting: async () => {},
    clients: {
      claim: async () => {},
      matchAll: async () => windows,
      openWindow: async (url) => { opened.push(url); return { url }; },
    },
  };

  let offline = false;
  const fetch = async (request) => {
    const url = typeof request === 'string' ? request : request.url;
    fetchLog.push(url);
    if (offline) throw new TypeError('Failed to fetch');
    return new Response('network', { status: 200, headers: { 'content-type': 'text/html' } });
  };

  runInNewContext(source, {
    self, caches, fetch, Response, Request, URL, URLSearchParams, TextDecoder, TextEncoder, Promise, console,
    indexedDB,
    btoa: globalThis.btoa,
    crypto: { getRandomValues: (bytes) => { bytes.fill(7); return bytes; } },
    setTimeout, clearTimeout,
  });

  // Minimal fetch-event surface: the worker calls event.respondWith(promise)
  // or returns without calling it, which is exactly the signal we assert on.
  const dispatch = (request, additions = {}) => {
    let responded;
    const event = { request, ...additions, respondWith: (p) => { responded = p; } };
    listeners.get('fetch')(event);
    return { responded, promise: responded };
  };

  // Lifecycle events hand their work to the runtime through waitUntil.
  const dispatchLifecycle = (type) => {
    const waits = [];
    listeners.get(type)({ waitUntil: (promise) => waits.push(promise) });
    return Promise.all(waits);
  };

  // A push event carries an optional payload; a click event carries the
  // notification that was shown. Both hand their work to waitUntil.
  const dispatchPush = (payload) => {
    const waits = [];
    const event = {
      data: payload === undefined ? null : { json: () => payload },
      waitUntil: (promise) => waits.push(promise),
    };
    listeners.get('push')(event);
    return Promise.all(waits);
  };

  const dispatchNotificationClick = (data) => {
    const waits = [];
    let closed = false;
    const event = {
      notification: { data, close: () => { closed = true; } },
      waitUntil: (promise) => waits.push(promise),
    };
    listeners.get('notificationclick')(event);
    return Promise.all(waits).then(() => ({ closed }));
  };

  return {
    dispatch, dispatchLifecycle, dispatchPush, dispatchNotificationClick,
    fetchLog, cacheContents, listeners, notifications, windows, opened, shareRecords,
    setOffline: (value) => { offline = value; },
  };
}

const get = (path, mode = 'cors') => ({
  url: `${ORIGIN}${path}`,
  method: 'GET',
  mode,
});

test('registration resolves from the deployment root, not /wallet/', () => {
  assert.deepEqual(serviceWorkerRegistration(''), {
    url: '/sw.js',
    scope: '/',
  });
  assert.deepEqual(serviceWorkerRegistration('/satoshicore'), {
    url: '/satoshicore/sw.js',
    scope: '/satoshicore/',
  });
  assert.deepEqual(serviceWorkerRegistration('/satoshicore/'), {
    url: '/satoshicore/sw.js',
    scope: '/satoshicore/',
  });
});

test('chain/account API paths bypass the worker entirely', () => {
  const { dispatch, fetchLog } = loadWorker();

  const paths = [
    '/api/v1/chain/info',
    '/api/v1/network/status',
    '/api/v1/account?acc=GABC',
    '/api/v1/explorer/snapshot',
    '/v1/health',
    '/v1/accounts/GABC/transactions?limit=50',
    '/v1/confirmations/' + 'a'.repeat(64),
    '/health',
    '/info',
    '/account?acc=GABC',
    '/metrics',
  ];

  for (const path of paths) {
    const { responded } = dispatch(get(path));
    assert.equal(responded, undefined, `${path} must not be intercepted by the service worker`);
  }
  assert.equal(fetchLog.length, 0, 'the worker must not even fetch an API path on its own');
});

test('static shell paths are served through the worker', async () => {
  assert.ok(VERSION, 'the worker must declare a cache VERSION');
  const { dispatch, cacheContents } = loadWorker();

  // Simulate an installed cache with a shell page in it.
  cacheContents.set(VERSION, new Map([
    [`${ORIGIN}/wallet/`, new Response('shell', { status: 200 })],
  ]));

  const { responded } = dispatch(get('/_next/static/chunks/main.js'));
  assert.ok(responded, 'static asset should be handled so it can be cached');
  const res = await responded;
  assert.equal(res.status, 200);

  const store = cacheContents.get(VERSION);
  assert.ok(
    [...store.keys()].includes(`${ORIGIN}/_next/static/chunks/main.js`),
    'a successful static fetch should be cached'
  );
});

test('offline navigation falls back to the cached wallet shell', async () => {
  const { dispatch, cacheContents, setOffline } = loadWorker();
  cacheContents.set(VERSION, new Map([
    [`${ORIGIN}/wallet/`, new Response('shell', { status: 200 })],
  ]));
  setOffline(true);

  const { responded } = dispatch(get('/wallet/', 'navigate'));
  assert.ok(responded, 'a navigation must always be answered, even offline');
  const res = await responded;
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'shell', 'offline navigation should serve the cached wallet');
});

test('a navigation with a query string does not create one cache entry per query', async () => {
  const { dispatch, cacheContents } = loadWorker();

  const searched = dispatch(get('/explorer/?q=abc123', 'navigate'));
  await searched.responded;
  const plain = dispatch(get('/download/', 'navigate'));
  await plain.responded;

  const store = cacheContents.get(VERSION);
  assert.ok(store.has(`${ORIGIN}/download/`), 'a plain navigation is cached for offline use');
  assert.ok(
    !store.has(`${ORIGIN}/explorer/?q=abc123`),
    'query-string navigations must not accumulate in the cache',
  );
});

test('activate drops stale runtime entries and only deletes its own old caches', async () => {
  const { dispatchLifecycle, cacheContents } = loadWorker();
  cacheContents.set('some-other-app-cache', new Map([
    [`${ORIGIN}/x.js`, new Response('other')],
  ]));
  cacheContents.set('nsat-pwa-v4', new Map([
    [`${ORIGIN}/old-chunk.js`, new Response('old')],
  ]));
  cacheContents.set(VERSION, new Map([
    [`${ORIGIN}/wallet/`, new Response('shell')],
    [`${ORIGIN}/_next/static/chunks/old-hash.js`, new Response('old')],
  ]));

  await dispatchLifecycle('activate');

  assert.ok(cacheContents.has('some-other-app-cache'), 'foreign caches must survive activate');
  assert.ok(!cacheContents.has('nsat-pwa-v4'), 'the previous shell cache is removed');
  const store = cacheContents.get(VERSION);
  assert.ok(store.has(`${ORIGIN}/wallet/`), 'the shell is kept');
  assert.ok(!store.has(`${ORIGIN}/_next/static/chunks/old-hash.js`), 'stale build assets are evicted');
});

test('a push shows one generic alert that opens the conversation it named', async () => {
  const { dispatchPush, notifications } = loadWorker();
  const peer = `G${'A'.repeat(55)}`;

  await dispatchPush({ v: 1, peer });

  assert.equal(notifications.length, 1);
  const [note] = notifications;
  assert.equal(note.title, 'NSAT Wallet');
  // The visible text is written on the device and says nothing about the sender.
  assert.doesNotMatch(note.options.body, /G[A-Z2-7]{55}/);
  assert.match(note.options.body, /encrypted message/i);
  // The routing hint becomes the URL, so a tap lands in the right room.
  assert.equal(note.options.data.url, `${ORIGIN}/wallet/?peer=${encodeURIComponent(peer)}`);
  assert.equal(note.options.tag, 'nsat-chat');
});

test('a push with no usable peer still alerts, and opens the chat screen', async () => {
  const { dispatchPush, notifications } = loadWorker();

  await dispatchPush({ v: 1, peer: 'not-an-address' });
  await dispatchPush(undefined);

  assert.equal(notifications.length, 2);
  assert.equal(notifications[0].options.data.url, `${ORIGIN}/wallet/`);
  assert.equal(notifications[1].options.data.url, `${ORIGIN}/wallet/`);
});

test('tapping the alert focuses this app and opens the room in that window', async () => {
  const { dispatchNotificationClick, windows, opened } = loadWorker();
  const focused = [];
  const navigations = [];
  windows.push({
    url: `${ORIGIN}/wallet/`,
    focus: async () => { focused.push(true); },
    navigate: async (url) => { navigations.push(url); },
  });

  const result = await dispatchNotificationClick({ url: `${ORIGIN}/wallet/?peer=G${'A'.repeat(55)}` });

  assert.equal(result.closed, true);
  assert.equal(focused.length, 1);
  assert.equal(navigations.length, 1);
  assert.match(navigations[0], /\/wallet\/\?peer=G/);
  assert.equal(opened.length, 0, 'an existing window is reused instead of opening a new tab');
});

test('a window already showing that room is focused, never reloaded', async () => {
  const { dispatchNotificationClick, windows, opened } = loadWorker();
  const url = `${ORIGIN}/wallet/?peer=G${'A'.repeat(55)}`;
  const navigations = [];
  windows.push({
    url,
    focus: async () => {},
    navigate: async (target) => { navigations.push(target); },
  });

  await dispatchNotificationClick({ url });

  assert.equal(navigations.length, 0, 'an unlocked session must not be reloaded by a tap');
  assert.equal(opened.length, 0);
});

test('with no window open the alert opens one at the room', async () => {
  const { dispatchNotificationClick, opened } = loadWorker();

  await dispatchNotificationClick({ url: `${ORIGIN}/wallet/?peer=G${'B'.repeat(55)}` });

  assert.equal(opened.length, 1);
  assert.match(opened[0], /\/wallet\/\?peer=GB/);
});

test('share-target POST stores bounded content locally and redirects with a one-time id', async () => {
  const { dispatch, fetchLog, cacheContents, shareRecords } = loadWorker();
  const request = {
    url: `${ORIGIN}/share/`,
    method: 'POST',
    mode: 'navigate',
    headers: { get: () => 'application/x-www-form-urlencoded' },
    body: { getReader: () => {
      const chunk = new TextEncoder().encode('title=Private+title&text=Private+text&url=https%3A%2F%2Fexample.test%2Fsecret');
      let read = false;
      return { read: async () => read ? { done: true } : (read = true, { done: false, value: chunk }), cancel: async () => {} };
    } },
  };
  const { responded } = dispatch(request);
  assert.ok(responded, 'the share POST must be handled before network fallback');
  const result = await responded;
  assert.equal(result.status, 200);
  assert.match(result.headers.get('cache-control'), /no-store/i);
  assert.match(result.headers.get('cache-control'), /no-store/i);
  const html = await result.text();
  const [, id] = html.match(/share\/\?id=([a-f0-9]{32})/) || [];
  assert.equal(id, '07'.repeat(16));
  assert.doesNotMatch(html, /Private title|Private text|example\.test\/secret/,
    'shared values are not embedded in redirect HTML');
  assert.equal(shareRecords.size, 1, 'payload remains on-device in the one-time inbox');
  const record = [...shareRecords.values()][0];
  assert.deepEqual({ title: record.title, text: record.text, url: record.url }, {
    title: 'Private title', text: 'Private text', url: 'https://example.test/secret',
  });
  assert.equal(fetchLog.length, 0, 'the share POST body must never reach the static host');
  assert.deepEqual([...cacheContents.values()].flatMap((store) => [...store.keys()]), [],
    'shared content must never be put in Cache API');
  assert.equal(shareRecords.size, 1);
  assert.deepEqual({ title: [...shareRecords.values()][0].title, text: [...shareRecords.values()][0].text, url: [...shareRecords.values()][0].url }, {
    title: 'Private title', text: 'Private text', url: 'https://example.test/secret',
  });
});

test('an invalid share body is rejected and never forwarded to the server', async () => {
  const { dispatch, fetchLog } = loadWorker();
  const request = {
    url: `${ORIGIN}/share/`, method: 'POST', mode: 'navigate',
    headers: { get: () => 'application/x-www-form-urlencoded' },
    body: { getReader: () => { throw new Error('body unavailable'); } },
  };
  const result = await dispatch(request).responded;
  assert.equal(result.status, 400);
  assert.match(await result.text(), /could not be opened/i);
  assert.match(result.headers.get('cache-control'), /no-store/i);
  assert.equal(fetchLog.length, 0);
});

test('oversized or non-form share requests are rejected without forwarding body', async () => {
  const { dispatch, fetchLog } = loadWorker();
  const oversized = new Uint8Array(32 * 1024 + 1);
  const body = {
    getReader: () => ({
      read: async () => ({ done: false, value: oversized }),
      cancel: async () => {},
    }),
  };
  const tooLarge = dispatch({
    url: `${ORIGIN}/share/`, method: 'POST', mode: 'navigate', body,
    headers: { get: () => 'application/x-www-form-urlencoded' },
  });
  const failed = await tooLarge.responded;
  assert.equal(failed.status, 400);
  assert.match(failed.headers.get('cache-control'), /no-store/i);

  const wrongType = dispatch({
    url: `${ORIGIN}/share/`, method: 'POST', mode: 'navigate', body,
    headers: { get: () => 'multipart/form-data' },
  });
  const rejected = await wrongType.responded;
  assert.equal(rejected.status, 400);
  assert.equal(fetchLog.length, 0);
});

test('non-GET and cross-origin requests are never intercepted', () => {
  const { dispatch, fetchLog } = loadWorker();

  const post = { url: `${ORIGIN}/api/v1/tx`, method: 'POST', mode: 'cors' };
  assert.equal(dispatch(post).responded, undefined, 'POST must bypass the worker');

  const crossOrigin = { url: 'https://gateway.satoshicore.org/api/v1/chain/info', method: 'GET', mode: 'cors' };
  assert.equal(dispatch(crossOrigin).responded, undefined, 'cross-origin must bypass the worker');

  assert.equal(fetchLog.length, 0);
});
