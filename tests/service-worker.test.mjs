// Behavioural test for the offline-shell service worker.
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

const SW_PATH = join(process.cwd(), 'out', 'sw.js');
const ORIGIN = 'https://satoshicore.org';

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

  const self = {
    location: { origin: ORIGIN },
    registration: { scope: `${ORIGIN}/` },
    addEventListener: (type, fn) => listeners.set(type, fn),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };

  const fetch = async (request) => {
    const url = typeof request === 'string' ? request : request.url;
    fetchLog.push(url);
    return new Response('network', { status: 200, headers: { 'content-type': 'text/html' } });
  };

  runInNewContext(source, {
    self, caches, fetch, Response, Request, URL, Promise, console,
    setTimeout, clearTimeout,
  });

  // Minimal fetch-event surface: the worker calls event.respondWith(promise)
  // or returns without calling it, which is exactly the signal we assert on.
  const dispatch = (request) => {
    let responded;
    const event = { request, respondWith: (p) => { responded = p; } };
    listeners.get('fetch')(event);
    return { responded, promise: responded };
  };

  return { dispatch, fetchLog, cacheContents, listeners };
}

const get = (path, mode = 'cors') => ({
  url: `${ORIGIN}${path}`,
  method: 'GET',
  mode,
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
  const { dispatch, cacheContents } = loadWorker();

  // Simulate an installed cache with a shell page in it.
  cacheContents.set('nsat-pwa-v3', new Map([
    [`${ORIGIN}/wallet/`, new Response('shell', { status: 200 })],
  ]));

  const { responded } = dispatch(get('/_next/static/chunks/main.js'));
  assert.ok(responded, 'static asset should be handled so it can be cached');
  const res = await responded;
  assert.equal(res.status, 200);

  const store = cacheContents.get('nsat-pwa-v3');
  assert.ok(
    [...store.keys()].includes(`${ORIGIN}/_next/static/chunks/main.js`),
    'a successful static fetch should be cached'
  );
});

test('non-GET and cross-origin requests are never intercepted', () => {
  const { dispatch, fetchLog } = loadWorker();

  const post = { url: `${ORIGIN}/api/v1/tx`, method: 'POST', mode: 'cors' };
  assert.equal(dispatch(post).responded, undefined, 'POST must bypass the worker');

  const crossOrigin = { url: 'https://gateway.satoshicore.org/api/v1/chain/info', method: 'GET', mode: 'cors' };
  assert.equal(dispatch(crossOrigin).responded, undefined, 'cross-origin must bypass the worker');

  assert.equal(fetchLog.length, 0);
});
