'use client';

// Registers the offline-shell service worker (public/sw.js).
//
// Only in production and only on a secure context: a service worker is
// pointless in `next dev` (it would cache a build that changes on every save)
// and the browser refuses to register one on plain HTTP outside localhost.
// Failures are silent by design — a wallet must work without a service worker,
// and a registration error is not a wallet error.
import { useEffect } from 'react';

export default function SwRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
    const secure = window.isSecureContext
      || window.location.hostname === 'localhost'
      || window.location.hostname === '127.0.0.1';
    if (!secure) return;

    const register = () => {
      // document.baseURI already includes the deployment base path.
      const url = new URL('sw.js', document.baseURI).toString();
      navigator.serviceWorker.register(url, { scope: './' }).catch(() => {});
    };

    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
    return () => window.removeEventListener('load', register);
  }, []);

  return null;
}
