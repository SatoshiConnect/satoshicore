'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  formatStorageBytes, readPwaStorage, requestPwaPersistence, storageUsagePercent,
} from '../lib/pwaStorage';

export default function PwaStorageCard() {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const refresh = useCallback(async () => {
    const next = await readPwaStorage();
    setStatus(next);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function protectStorage() {
    if (busy) return;
    setBusy(true);
    setNote('');
    const granted = await requestPwaPersistence();
    await refresh();
    setNote(granted
      ? 'This browser agreed not to evict this site’s stored data automatically. Keep an encrypted backup too.'
      : 'The browser did not grant persistent storage. Keep an encrypted backup; browser storage can still be cleared.');
    setBusy(false);
  }

  const percent = status ? storageUsagePercent(status) : null;
  return (
    <section className="nw-card" aria-labelledby="pwa-storage-title">
      <h2 id="pwa-storage-title" style={{ color: 'var(--text)' }}>This device’s storage</h2>
      {!status ? (
        <p className="nw-small nw-dim" role="status">Checking browser storage…</p>
      ) : !status.supported ? (
        <p className="nw-small nw-dim">This browser does not report storage usage or persistent storage support.</p>
      ) : (
        <>
          <div className="nw-kv" style={{ marginTop: 10 }}>
            <span className="nw-k">Used by this site</span>
            <span className="nw-v" data-testid="pwa-storage-usage">
              {status.usage == null ? 'Unknown' : formatStorageBytes(status.usage)}
              {' / '}
              {status.quota == null ? 'unknown quota' : formatStorageBytes(status.quota)}
            </span>
          </div>
          {percent != null ? (
            <div className="pwa-storage-meter" role="meter" aria-label="Site storage used"
              aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(percent)}>
              <span style={{ width: `${percent}%` }} />
            </div>
          ) : null}
          <div className="nw-kv">
            <span className="nw-k">Eviction protection</span>
            <span className="nw-v">
              {status.persisted === true ? 'Enabled on this browser' : status.persisted === false ? 'Not enabled' : 'Not reported'}
            </span>
          </div>
          {status.persisted !== true ? (
            <button type="button" className="nw-chip-btn" disabled={busy}
              onClick={() => void protectStorage()}>
              {busy ? 'Requesting…' : 'Protect this device’s storage'}
            </button>
          ) : null}
          <button type="button" className="nw-chip-btn" style={{ marginInlineStart: 8 }}
            disabled={busy} onClick={() => void refresh()}>
            Refresh usage
          </button>
          <p className="nw-small nw-dim" style={{ margin: '8px 0 0' }}>
            This is a browser estimate, not a backup. Persistent storage asks the browser not to evict this site automatically; it cannot prevent you or the browser from clearing data. Keep your encrypted wallet and chat backups.
          </p>
          {note ? <p className="nw-small" role="status">{note}</p> : null}
        </>
      )}
    </section>
  );
}
