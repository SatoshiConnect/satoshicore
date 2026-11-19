'use client';

import { useEffect, useState } from 'react';

function isIos(userAgent) {
  return /iPhone|iPad|iPod/i.test(String(userAgent || ''));
}

function isStandalone() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(display-mode: standalone)')?.matches === true
    || window.navigator?.standalone === true;
}

export default function PwaInstallButton() {
  const [prompt, setPrompt] = useState(null);
  const [installed, setInstalled] = useState(false);
  const [ios, setIos] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    const sync = () => {
      setPrompt(window.__nsatInstallPrompt || null);
      setInstalled(isStandalone());
      setIos(isIos(window.navigator.userAgent));
    };
    const onInstallable = () => setPrompt(window.__nsatInstallPrompt || null);
    const onInstalled = () => {
      setPrompt(null);
      setInstalled(true);
      setHelpOpen(false);
    };
    sync();
    window.addEventListener('nsat:installable', onInstallable);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('nsat:installable', onInstallable);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  async function install() {
    const deferred = prompt || window.__nsatInstallPrompt;
    if (!deferred) {
      setHelpOpen((open) => !open);
      return;
    }
    setPrompt(null);
    window.__nsatInstallPrompt = null;
    try {
      await deferred.prompt();
      await deferred.userChoice;
    } catch {
      setHelpOpen(true);
    }
  }

  if (installed) return null;
  // The browser will show its native prompt only on eligible devices. Keep an
  // explicit help entry available when it has no `beforeinstallprompt` event.
  return (
    <div className="pwa-install-wrap">
      <button type="button" className="pwa-install-button" onClick={() => void install()}
        aria-expanded={helpOpen} aria-controls="pwa-install-help">
        {ios ? 'Add to Home Screen' : 'Install app'}
      </button>
      {helpOpen ? (
        <div className="pwa-install-help" id="pwa-install-help" role="status">
          <strong>{ios ? 'Install on iPhone or iPad' : 'Install NSAT Wallet'}</strong>
          {ios ? (
            <p>Open this site in Safari, tap the Share button, choose “Add to Home Screen”, then tap “Add”. Background and offline features are available only after installing.</p>
          ) : (
            <p>Use your browser’s “Install app” or “Add to Home Screen” option from the address bar or browser menu. If it is not offered, keep using the wallet in this tab.</p>
          )}
          <button type="button" className="pwa-install-dismiss" onClick={() => setHelpOpen(false)}>Close</button>
        </div>
      ) : null}
    </div>
  );
}
