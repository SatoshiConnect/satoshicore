'use client';

// Settings card for the opt-in chat archive.
//
// The archive is off until someone turns it on here, stays on this device, and
// is encrypted under a key derived from the wallet seed. The Drive copy is the
// same archive re-sealed for upload, through the wallet's existing app-private
// Drive folder and OAuth grant. The limits are printed on the card itself, not
// only in the docs, because this is a privacy choice the person is making.
import { useEffect, useState } from 'react';

import { isFirebaseWebConfigured } from '../lib/firebaseAuth';
import { describeDriveFailure, downloadBackup, getDriveToken, uploadBackup } from '../lib/driveBackup';
import {
  clearArchivedWallet, countArchivedMessages, deriveArchiveKey, readArchivePrefs,
  readArchivedRows, restoreArchivedRows, writeArchivePrefs,
} from '../lib/chatArchive';
import {
  archiveBackupFileName, openArchiveBackup, sealArchiveBackup,
} from '../lib/chatArchiveBackup';
import DriveFailureDialog from './DriveFailureDialog';

const configured = isFirebaseWebConfigured();

const shortAddress = (value) => (value ? `${value.slice(0, 6)}…${value.slice(-4)}` : '');
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

export default function ChatArchiveCard({ session } = {}) {
  const [prefs, setPrefs] = useState(readArchivePrefs);
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dialog, setDialog] = useState(null);

  const address = session?.pubkey || '';
  const unlocked = Boolean(session?.seed32);

  useEffect(() => {
    setPrefs(readArchivePrefs());
    setConfirmDelete(false);
    setNote('');
    setError('');
  }, [address]);

  useEffect(() => {
    let alive = true;
    countArchivedMessages(address).then((value) => { if (alive) setCount(value); }).catch(() => {});
    return () => { alive = false; };
  }, [address, note]);

  function update(patch) {
    const next = writeArchivePrefs(patch);
    setPrefs(next);
    setError('');
    return next;
  }

  function toggleEnabled() {
    const next = update({ enabled: !prefs.enabled });
    setNote(next.enabled
      ? 'Saved chat history is on for this device. Messages are encrypted with a key derived from this wallet’s seed.'
      : 'Saved chat history is off. Messages already on this device were kept — delete them below if you want them gone.');
  }

  async function deleteLocal() {
    setBusy(true);
    setError('');
    try {
      await clearArchivedWallet(address);
      setCount(0);
      setConfirmDelete(false);
      setNote('Deleted this wallet’s saved chat history from this device.');
    } catch (err) {
      setError(String(err?.message || 'Could not delete the saved history.'));
    } finally {
      setBusy(false);
    }
  }

  async function backupNow() {
    setBusy(true);
    setError('');
    setNote('');
    try {
      if (!unlocked) throw new Error('Unlock the wallet first: the backup key comes from its seed.');
      const rows = await readArchivedRows(address);
      if (rows.length === 0) throw new Error('There is no saved chat history to back up yet.');
      const key = await deriveArchiveKey(session.seed32, address);
      const text = await sealArchiveBackup(key, { address, rows });
      const token = await getDriveToken();
      const saved = await uploadBackup(token, text, { fileName: archiveBackupFileName(address) });
      const next = update({ lastBackupAt: saved.modifiedTime || new Date().toISOString() });
      setPrefs(next);
      setNote(`${saved.existed ? 'Updated' : 'Saved'} ${plural(rows.length, 'message')} in your Google Drive app folder. The file is encrypted; opening it needs this wallet’s seed.`);
    } catch (err) {
      setError(String(err?.message || 'The chat backup did not complete.'));
      setDialog(describeDriveFailure(err));
    } finally {
      setBusy(false);
    }
  }

  async function restoreNow() {
    setBusy(true);
    setError('');
    setNote('');
    try {
      if (!unlocked) throw new Error('Unlock the wallet first: the backup key comes from its seed.');
      const token = await getDriveToken();
      const found = await downloadBackup(token, { fileName: archiveBackupFileName(address) });
      if (!found) {
        throw Object.assign(
          new Error('This wallet has no chat history backup in Google Drive yet.'),
          { code: 'NO_BACKUP' },
        );
      }
      const key = await deriveArchiveKey(session.seed32, address);
      const opened = await openArchiveBackup(key, found.text, { address });
      const added = await restoreArchivedRows(address, opened.rows);
      setCount(await countArchivedMessages(address));
      setNote(`Restored ${plural(added, 'message')} from the Drive copy${opened.createdAt ? ` saved ${new Date(opened.createdAt).toLocaleString()}` : ''}. Messages already on this device were kept.`);
    } catch (err) {
      setError(String(err?.message || 'The chat restore did not complete.'));
      setDialog(describeDriveFailure(err));
    } finally {
      setBusy(false);
    }
  }

  const canUseDrive = configured && Boolean(address) && unlocked;

  return (
    <section className="nw-card" aria-labelledby="nw-chat-archive-title">
      <h2 id="nw-chat-archive-title" style={{ color: 'var(--text)' }}>Chat history on this device</h2>
      <p className="nw-small nw-dim" style={{ margin: '8px 0 10px' }}>
        Off by default: messages live only while the tab is open. Turning this on keeps this
        wallet’s conversations on this device, encrypted with a key derived from its seed — there
        is no extra password to remember and no key to export.
      </p>
      <p className="nw-small nw-dim" style={{ margin: '0 0 10px' }}>
        Pending payment requests are kept separately in the same encrypted local database, even
        when this history toggle is off. Deleting message history does not delete them.
      </p>
      {!address ? (
        <p className="nw-small nw-dim" role="status">Unlock a wallet to choose what to keep on this device.</p>
      ) : (
        <>
          <div className="nw-kv">
            <span className="nw-k">Wallet</span>
            <span className="nw-v nw-small">{session?.name ? `${session.name} · ` : ''}{shortAddress(address)}</span>
          </div>
          <div className="nw-kv">
            <span className="nw-k">Save on this device</span>
            <span className="nw-v">
              <button type="button" className="nw-chip-btn" aria-pressed={prefs.enabled}
                onClick={toggleEnabled} disabled={busy}>
                {prefs.enabled ? 'On — turn off' : 'Off — turn on'}
              </button>
            </span>
          </div>
          <div className="nw-kv">
            <span className="nw-k">Wipe when the wallet locks</span>
            <span className="nw-v">
              <button type="button" className="nw-chip-btn" aria-pressed={prefs.wipeOnLock}
                onClick={() => update({ wipeOnLock: !prefs.wipeOnLock })}
                disabled={busy || !prefs.enabled}>
                {prefs.wipeOnLock ? 'On' : 'Off'}
              </button>
            </span>
          </div>
          <div className="nw-kv">
            <span className="nw-k">Stored here</span>
            <span className="nw-v nw-small">{plural(count, 'message')}</span>
          </div>

          <div className="nw-btn-row" style={{ marginTop: 10 }}>
            <button type="button" className="nw-chip-btn" onClick={backupNow}
              disabled={busy || !canUseDrive || count === 0}>
              {busy ? 'Working…' : 'Back up to Drive'}
            </button>
            <button type="button" className="nw-chip-btn" onClick={restoreNow}
              disabled={busy || !canUseDrive}>
              Restore from Drive
            </button>
            {confirmDelete ? (
              <>
                <button type="button" className="nw-chip-btn" onClick={deleteLocal} disabled={busy}>
                  Delete {plural(count, 'message')}
                </button>
                <button type="button" className="nw-chip-btn" disabled={busy}
                  onClick={() => { setConfirmDelete(false); setNote('Nothing was deleted.'); }}>
                  Cancel
                </button>
              </>
            ) : (
              <button type="button" className="nw-chip-btn" disabled={busy || count === 0}
                onClick={() => { setConfirmDelete(true); setNote(''); }}>
                Delete local history
              </button>
            )}
          </div>

          <p className="nw-small nw-dim" style={{ margin: '8px 0 0' }}>
            {prefs.lastBackupAt
              ? `Last Drive backup: ${new Date(prefs.lastBackupAt).toLocaleString()}.`
              : 'No Drive backup of this history yet.'}
          </p>
          {!configured ? (
            <p className="nw-small nw-dim" role="status" style={{ margin: '6px 0 0' }}>
              Google sign-in is not configured in this build, so only on-device saving is available.
            </p>
          ) : null}
          {!unlocked ? (
            <p className="nw-small nw-dim" role="status" style={{ margin: '6px 0 0' }}>
              Unlock the wallet to read, back up or restore saved messages; the key is derived from its seed.
            </p>
          ) : null}
          {note ? <p className="nw-small nw-dim" role="status" style={{ margin: '8px 0 0' }}>{note}</p> : null}
          {error ? <p className="nw-small nw-google-error" role="alert" style={{ margin: '8px 0 0' }}>{error}</p> : null}

          <details className="nw-small nw-dim" style={{ marginTop: 12 }}>
            <summary style={{ cursor: 'pointer' }}>What this does and does not protect</summary>
            <ul style={{ margin: '8px 0 0', paddingLeft: 18, display: 'grid', gap: 6 }}>
              <li>The message text is encrypted at rest with a key derived from this wallet’s seed; the device stores no plaintext and no second password.</li>
              <li>Who talked to whom and when stays readable on this device, and Google Drive sees the file’s size and timing — the same metadata the relay already sees.</li>
              <li>Anyone who has the seed, or who can run code on this page while the wallet is unlocked, can read the archive. It does not survive a leaked seed.</li>
              <li>“Wipe when the wallet locks” deletes the records, but flash storage may keep old blocks until they are overwritten — it is not a forensic erase.</li>
              <li>The Drive copy is encrypted with the same seed-derived key: restoring needs this wallet’s seed, and an email login alone cannot open it.</li>
            </ul>
          </details>
        </>
      )}

      <DriveFailureDialog dialog={dialog} onClose={() => setDialog(null)} />
    </section>
  );
}
