/* SatoshiCore Wallet service worker.
 * Caches ONLY the static app shell (network-first with offline fallback).
 * Never caches: any /rpc response, any client credential, any user data. */
const SHELL = "scw-shell-v1";
const ASSETS = ["./", "./index.html", "./styles.css", "./main.js", "./manifest.webmanifest"];

self.addEventListener("install", (ev) => {
  ev.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS))
    .then(() => self.skipWaiting()));
});
self.addEventListener("activate", (ev) => {
  ev.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (ev) => {
  const url = new URL(ev.request.url);
  if (ev.request.method !== "GET") return;          // RPC POSTs pass through
  if (url.pathname.includes("/rpc")) return;       // never cache gateway calls
  ev.respondWith(
    fetch(ev.request).then((r) => {
      if (r.ok && url.origin === location.origin) {
        const copy = r.clone();
        caches.open(SHELL).then((c) => c.put(ev.request, copy));
      }
      return r;
    }).catch(() =>
      caches.match(ev.request).then((r) => r || caches.match("./index.html"))));
});
