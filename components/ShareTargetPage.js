'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { consumeSharedContent } from '../lib/pwaShareInbox';

// The service worker stores the bounded payload briefly in device-local
// IndexedDB and redirects with a random one-time id; consume removes it.
export default function ShareTargetPage() {
  const [shared, setShared] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('id');
    params.delete('id');
    const query = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
    if (!id) { setFailed(true); return; }
    void consumeSharedContent(id).then((value) => {
      if (value) setShared(value);
      else setFailed(true);
    }).catch(() => setFailed(true));
  }, []);

  return (
    <div className="stack pwa-share-page">
      <section className="panel">
        <div className="panel-head"><h1 className="panel-title">Shared with NSAT Wallet</h1></div>
        <div className="panel-body">
          <p className="pwa-share-disclosure">
            Review what was shared. Nothing is sent to a chat, uploaded, or used for a transaction unless you choose an action yourself.
          </p>
          {!shared && !failed ? <p role="status">Reading shared content…</p> : null}
          {failed ? <p className="pwa-share-empty" role="alert">This share is unavailable or expired. Try sharing it again.</p> : null}
          {shared ? (
            <div className="pwa-share-content" aria-label="Shared content">
              {shared.title ? <strong>{shared.title}</strong> : null}
              {shared.text ? <p>{shared.text}</p> : null}
              {shared.url ? <p>{shared.url}</p> : null}
            </div>
          ) : null}
          <div className="pwa-share-actions">
            {shared ? <CopySharedContent shared={shared} /> : null}
            <Link href="/" className="button secondary">Open wallet</Link>
          </div>
        </div>
      </section>
    </div>
  );
}

function CopySharedContent({ shared }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const value = [shared.title, shared.text, shared.url]
    .map((part) => String(part || '').trim()).filter(Boolean).join('\\n\\n');
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setFailed(false);
    } catch { setFailed(true); }
  }
  return (
    <>
      <button type="button" className="button" onClick={() => void copy()}>
        {copied ? 'Copied' : 'Copy shared content'}
      </button>
      {failed ? <span role="alert">Could not copy. Select and copy the text above.</span> : null}
    </>
  );
}
