'use client';

import { useEffect, useState } from 'react';

// A real install affordance, never a fake prompt.
//
// Chrome/Edge/Brave fire `beforeinstallprompt` when the page is installable.
// We capture that event and replay it only on a user gesture, so the button
// cannot ask the browser to install something it is not offering. Safari
// (iOS/iPadOS) has no such event at all, so there we show the real
// Share → Add to Home Screen steps instead of pretending to install.
export default function InstallApp() {
  const [promptEvent, setPromptEvent] = useState(null);
  const [installed, setInstalled] = useState(false);
  const [iosSteps, setIosSteps] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
    if (standalone) {
      setInstalled(true);
      return undefined;
    }

    const onPrompt = (event) => {
      // Keep the event for our own button instead of the browser's mini-infobar.
      event.preventDefault();
      setPromptEvent(event);
    };
    const onInstalled = () => {
      setInstalled(true);
      setPromptEvent(null);
    };
    // layout.js captures the event before hydration; pick that instance up, and
    // handle one arriving later (the listener there re-dispatches for us).
    const fromHead = () => {
      if (window.__nsatInstallPrompt) setPromptEvent(window.__nsatInstallPrompt);
    };
    fromHead();
    window.addEventListener('nsat:installable', fromHead);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);

    const ua = window.navigator.userAgent;
    const ios = /iPad|iPhone|iPod/.test(ua)
      || (window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1);
    // Only Safari on iOS can add a web app to the Home Screen.
    setIosSteps(ios && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua));

    return () => {
      window.removeEventListener('nsat:installable', fromHead);
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (installed) {
    return <span className="nw-extras-note">Installed app · opens standalone</span>;
  }

  if (promptEvent) {
    return (
      <button
        type="button"
        className="button secondary"
        disabled={busy}
        onClick={async () => {
          const ev = promptEvent;
          setBusy(true);
          try {
            await ev.prompt();
            const choice = await ev.userChoice;
            if (choice && choice.outcome === 'accepted') setInstalled(true);
            // A dismissed prompt cannot be replayed; drop it so the button
            // never promises an install the browser will ignore.
            setPromptEvent(null);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Waiting for the browser…' : 'Install app'}
      </button>
    );
  }

  if (iosSteps) {
    return (
      <details className="nw-ios-install">
        <summary className="button secondary">Add to Home Screen</summary>
        <p className="nw-extras-note">
          In Safari, tap Share, then “Add to Home Screen”. Only Safari on
          iPhone and iPad can install this wallet as an app.
        </p>
      </details>
    );
  }

  // The browser has not offered a prompt (Chrome only does after it decides
  // the page is installable, and only for engaged visitors). Say what the
  // browser's own menu does — never simulate an install dialog.
  return (
    <details className="nw-ios-install">
      <summary className="button secondary">Install app</summary>
      <p className="nw-extras-note">
        Open the browser menu and choose “Install…” (Chrome, Edge and Brave on
        desktop and Android) or “Add to Home Screen” (Safari on iPhone and
        iPad). Firefox does not install web apps; use the site in the browser
        there.
      </p>
    </details>
  );
}
