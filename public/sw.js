/* NSAT Wallet service worker — offline shell + device-local share handoff.
 *
 * Scope of this worker is deliberately narrow:
 *   - it caches the STATIC shell (pages + icons + manifest) of the site it is
 *     served from, so the wallet UI opens without a network;
 *   - it never touches cross-origin requests. The gateway and the indexer are
 *     different origins, and a wallet must never serve a stale balance, a stale
 *     ledger result or a cached transaction verdict from a cache.
 *   - it never caches a non-GET request. A narrowly-scoped share POST is
 *     handled locally and rendered no-store; API submissions are not replayed.
 *
 * The wallet needs the network for balances, fees and confirmation. Offline
 * support here means "the UI loads and says it is offline", not "the wallet
 * works offline".
 */

const VERSION = 'nsat-pwa-v6';
// Only caches this worker owns may be deleted on activate. Another tool on the
// same origin (a previous PWA, a docs site) keeps its caches.
const CACHE_PREFIX = 'nsat-pwa-';
// A cache that grows on every deployment is a disk leak, not an offline shell.
// Only the precached shell is kept indefinitely; everything else is evicted.
const MAX_ENTRIES = 120;

// Relative to the registration scope, so the same file works from the domain
// root and from a GitHub Pages project subpath.
const SHELL = [
  '',
  'wallet/',
  'share/',
  'share-copy.js',
  'download/',
  'offline.html',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

// Production serves the gateway and indexer through this same origin. Never
// intercept/copy their read endpoints into Cache API just because the browser
// sees the Caddy host as same-origin. Also skip legacy core routes that Caddy
// proxies directly; these may contain changing chain/account state.
const isDynamicApiPath = (pathname) =>
  /^\/(?:api|v1)(?:\/|$)/.test(pathname)
  || /^\/(?:health|info|account|tx|peers|quorum|metrics)(?:\/|$)/.test(pathname);

const scoped = (path) => new URL(path, self.registration.scope).toString();
const shellUrls = () => new Set(SHELL.map(scoped));

// Keep the cache bounded. `dropRuntime` is used on activate: a deployment is a
// clean slate, so hashed assets from the previous build stop occupying space.
// Without it, only the oldest non-shell entries are evicted past MAX_ENTRIES.
async function trimCache(cache, { dropRuntime = false } = {}) {
  const keep = shellUrls();
  const keys = await cache.keys();
  const removable = keys.filter((request) => !keep.has(request.url));
  const overflow = Math.max(0, keys.length - MAX_ENTRIES);
  const victims = dropRuntime ? removable : removable.slice(0, overflow);
  for (const request of victims) await cache.delete(request);
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // One missing optional page must not abort the install.
    await Promise.all(SHELL.map(async (path) => {
      try {
        await cache.add(new Request(scoped(path), { cache: 'reload' }));
      } catch {
        /* ignored — the shell still serves what did cache */
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && key !== VERSION)
      .map((key) => caches.delete(key)));
    // Old hashed chunks and one-off navigation snapshots from the previous
    // build cannot be revalidated: the files they describe are gone.
    const cache = await caches.open(VERSION);
    await trimCache(cache, { dropRuntime: true });
    await self.clients.claim();
  })());
});

// --- background alerts ------------------------------------------------------
// The relay's payload is a routing hint and nothing else: {"v":1,"peer":"G…"}.
// No text, no name, no count. The body below is written here, on the device.
// Whether the alert fires at all is the person's explicit choice in the app.
const PEER_RE = /^G[A-Z2-7]{55}$/;

function notificationTarget(peer) {
  const target = String(peer || '').toUpperCase();
  const room = PEER_RE.test(target) ? `?peer=${encodeURIComponent(target)}` : '';
  return scoped(`wallet/${room}`);
}

self.addEventListener('push', (event) => {
  let peer = '';
  try {
    const data = event.data ? event.data.json() : null;
    if (data && data.v === 1) peer = String(data.peer || '');
  } catch {
    // A malformed or empty payload still means "something arrived"; the
    // notification stays generic rather than failing silently.
  }
  const url = notificationTarget(peer);
  event.waitUntil(self.registration.showNotification('NSAT Wallet', {
    body: 'New encrypted message. Open it to decrypt on this device.',
    tag: 'nsat-chat',
    renotify: true,
    icon: scoped('icons/icon-192.png'),
    badge: scoped('icons/icon-192.png'),
    // Handed to notificationclick; the notification itself carries no message.
    data: { url },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification?.close();
  const url = String(event.notification?.data?.url || scoped('wallet/'));
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const own = windows.filter((client) => String(client.url || '').startsWith(self.registration.scope));
    if (own.length) {
      const [first] = own;
      // Focus, then point the existing window at the conversation. Navigating a
      // window we do not control would be a cross-origin hazard, hence the
      // scope filter above. A window already showing that room is left alone:
      // reloading it would throw away an unlocked wallet session.
      if (typeof first.focus === 'function') await first.focus();
      if (String(first.url || '') === url) return;
      if (typeof first.navigate === 'function') {
        try {
          await first.navigate(url);
          return;
        } catch {
          /* fall through to openWindow */
        }
      }
      return;
    }
    if (self.clients.openWindow) await self.clients.openWindow(url);
  })());
});

// Text/link shares arrive as a form POST. Handle only the in-scope share action,
// bound the body, and render a no-store response on this device. The body is
// never forwarded to the static host or written to Cache API/IndexedDB. No file
// field is accepted here; media sharing is a separate future flow.
const SHARE_MAX_BODY_BYTES = 32 * 1024;
const SHARE_DB = 'nsat-pwa-share-v1';
const SHARE_STORE = 'inbox';
const SHARE_MAX_AGE_MS = 5 * 60 * 1000;
const SHARE_MAX_RECORDS = 10;

function openShareDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SHARE_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(SHARE_STORE)) {
        request.result.createObjectStore(SHARE_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function randomShareId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

async function storeShare(fields) {
  const createdAt = Date.now();
  const row = {
    id: randomShareId(), createdAt,
    title: String(fields.title || '').slice(0, 200),
    text: String(fields.text || '').slice(0, 5000),
    url: String(fields.url || '').slice(0, 2048),
  };
  const db = await openShareDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SHARE_STORE, 'readwrite');
      const store = tx.objectStore(SHARE_STORE);
      const all = store.getAll();
      all.onsuccess = () => {
        const rows = (all.result || []).filter((item) => item.id !== row.id);
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
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return row.id;
  } finally {
    db.close();
  }
}

function shareResponse(fields, error = false) {
  const target = fields?.id ? `${scoped('share/')}?id=${fields.id}` : scoped('share/');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; base-uri 'none'; form-action 'none'"><meta http-equiv="refresh" content="0;url=${target}"><title>Opening shared content</title></head><body><p>${error ? 'This share could not be opened. Try again while the installed app is online.' : 'Opening the share review…'}</p><a href="${target}">Continue</a></body></html>`;
  return new Response(html, {
    status: error ? 400 : 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, private',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

async function readShareFields(request) {
  const contentType = String(request.headers?.get?.('content-type') || '').toLowerCase();
  if (!contentType.startsWith('application/x-www-form-urlencoded')) throw new Error('unsupported share encoding');
  const reader = request.body?.getReader?.();
  if (!reader) throw new Error('share body unavailable');
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > SHARE_MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error('share body too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const fields = new URLSearchParams(new TextDecoder().decode(bytes));
  return {
    title: fields.get('title') || '',
    text: fields.get('text') || '',
    url: fields.get('url') || '',
  };
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  let requestUrl;
  try { requestUrl = new URL(request.url); } catch { return; }
  const shareAction = scoped('share/');
  if (request.method === 'POST' && requestUrl.origin === self.location.origin
      && requestUrl.href.split('?')[0] === shareAction) {
    event.respondWith((async () => {
      try {
        const fields = await readShareFields(request);
        const id = await storeShare(fields);
        return shareResponse({ id });
      } catch {
        // Do not forward the POST to the static server: that would expose the
        // content in access logs and is not a valid share acceptance anyway.
        return shareResponse(null, true);
      }
    })());
    return;
  }
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  // Cross-origin (gateway, indexer) and non-http(s): never cached, never served
  // from a cache. A stale money value is worse than an honest error.
  if (url.origin !== self.location.origin) return;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  // Same-origin API endpoints must remain network-only too (Caddy proxies them
  // to the live Mainnet gateway/indexer under this very origin).
  if (isDynamicApiPath(url.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        // Cache the page itself, but never one entry per query string: an
        // explorer search (?q=…) would otherwise add a new entry on every
        // keystroke-driven navigation forever.
        if (fresh && fresh.ok && !url.search) {
          const cache = await caches.open(VERSION);
          cache.put(request, fresh.clone()).then(() => trimCache(cache)).catch(() => {});
        }
        return fresh;
      } catch {
        const cached = await caches.match(request, { ignoreSearch: true });
        if (cached) return cached;
        const shell = await caches.match(scoped('wallet/'), { ignoreSearch: true });
        if (shell) return shell;
        const offline = await caches.match(scoped('offline.html'));
        if (offline) return offline;
        return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) {
      // Refresh in the background so a new deployment is picked up next load.
      fetch(request).then(async (fresh) => {
        if (fresh && fresh.ok) {
          const cache = await caches.open(VERSION);
          await cache.put(request, fresh.clone());
          await trimCache(cache);
        }
      }).catch(() => {});
      return cached;
    }
    try {
      const fresh = await fetch(request);
      if (fresh && fresh.ok) {
        const cache = await caches.open(VERSION);
        cache.put(request, fresh.clone()).then(() => trimCache(cache)).catch(() => {});
      }
      return fresh;
    } catch {
      return new Response('', { status: 504 });
    }
  })());
});
