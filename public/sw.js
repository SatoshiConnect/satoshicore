/* NSAT Wallet service worker — offline shell only.
 *
 * Scope of this worker is deliberately narrow:
 *   - it caches the STATIC shell (pages + icons + manifest) of the site it is
 *     served from, so the wallet UI opens without a network;
 *   - it never touches cross-origin requests. The gateway and the indexer are
 *     different origins, and a wallet must never serve a stale balance, a stale
 *     ledger result or a cached transaction verdict from a cache.
 *   - it never caches a non-GET request, so a submitted envelope is never
 *     replayed by the worker.
 *
 * The wallet needs the network for balances, fees and confirmation. Offline
 * support here means "the UI loads and says it is offline", not "the wallet
 * works offline".
 */

const VERSION = 'nsat-pwa-v2';

// Relative to the registration scope, so the same file works from the domain
// root and from a GitHub Pages project subpath.
const SHELL = [
  '',
  'wallet/',
  'download/',
  'offline.html',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

const scoped = (path) => new URL(path, self.registration.scope).toString();

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
    await Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
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

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        if (fresh && fresh.ok) {
          const cache = await caches.open(VERSION);
          cache.put(request, fresh.clone()).catch(() => {});
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
        }
      }).catch(() => {});
      return cached;
    }
    try {
      const fresh = await fetch(request);
      if (fresh && fresh.ok) {
        const cache = await caches.open(VERSION);
        cache.put(request, fresh.clone()).catch(() => {});
      }
      return fresh;
    } catch {
      return new Response('', { status: 504 });
    }
  })());
});
