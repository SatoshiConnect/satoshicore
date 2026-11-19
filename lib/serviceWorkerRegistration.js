// Resolve the offline-shell service worker from the deployment root, not from
// the page that happened to register it. `document.baseURI` on /wallet/ ends
// in /wallet/, so using it as the base requested /wallet/sw.js and got a 404.
export function serviceWorkerRegistration(basePath = '') {
  const base = String(basePath || '').replace(/\/+$/, '');
  return {
    url: `${base}/sw.js`,
    scope: `${base}/`,
  };
}
