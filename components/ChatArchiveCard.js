'use client';

// Settings card for the opt-in chat archive.
//
// The archive is off until someone turns it on here, stays on this device, and
// is encrypted under a key derived from the device chat identity. The Drive copy is the
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
  ensureChatIdentityAcrossTabs, readChatIdentity, saveChatIdentity,
} from '../lib/chatIdentity';
import { migrateChatData } from '../lib/chatMigration';
import {
  archiveBackupFileName, openArchiveBackup, sealArchiveBackup,
} from '../lib/chatArchiveBackup';
import {
  chatIdentityBackupFileName, openChatIdentityBackup, sealChatIdentityBackup,
} from '../lib/chatIdentityBackup';
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
  const [chatIdentity, setChatIdentity] = useState(null);
  const [keyConflict, setKeyConflict] = useState(null);

  const address = session?.pubkey || '';
  const keySeed = chatIdentity?.seed32 || null;
  const unlocked = Boolean(keySeed);

  useEffect(() => {
    setChatIdentity(address ? readChatIdentity(address) : null);
  }, [address]);

  useEffect(() => {
    if (!address || !session?.seed32 || !chatIdentity) return;
    void migrateChatData({
      walletSeed32: session.seed32, chatIdentity, address,
    }).catch(() => {});
  }, [address, session?.seed32, chatIdentity]);

  useEffect(() => {
    setPrefs(readArchivePrefs());
    setConfirmDelete(false);
    setNote('');
    setError('');
    setKeyConflict(null);
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
      ? 'Saved chat history is on for this device. Messages are encrypted with this device’s chat identity.'
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
      let current = readChatIdentity(address) || chatIdentity;
      if (!current && session?.seed32) {
        current = await ensureChatIdentityAcrossTabs({ address, walletSeed32: session.seed32 });
        if (current) setChatIdentity(current);
      }
      if (!current) throw new Error('Open chat once on this device first: the backup key comes from its chat identity.');
      if (session?.seed32) {
        await migrateChatData({ walletSeed32: session.seed32, chatIdentity: current, address });
      }
      const token = await getDriveToken();
      let identityBackedUp = false;
      let keyBackupAt = '';
      if (session?.seed32) {
        const identityText = await sealChatIdentityBackup({
          walletSeed32: session.seed32, address, identity: current,
        });
        const keySaved = await uploadBackup(token, identityText, { fileName: chatIdentityBackupFileName(address) });
        identityBackedUp = true;
        keyBackupAt = keySaved.modifiedTime || new Date().toISOString();
      }
      const rows = await readArchivedRows(address);
      if (rows.length === 0) {
        update({ lastBackupAt: keyBackupAt || new Date().toISOString() });
        setNote(identityBackedUp
          ? 'Saved this device’s chat key in your Google Drive app folder. There is no saved chat history yet.'
          : 'There is no saved chat history to back up yet.');
        return;
      }
      const key = await deriveArchiveKey(current.seed32, address, 'chat');
      const text = await sealArchiveBackup(key, { address, rows });
      const saved = await uploadBackup(token, text, { fileName: archiveBackupFileName(address) });
      const next = update({ lastBackupAt: saved.modifiedTime || new Date().toISOString() });
      setPrefs(next);
      setNote(`${identityBackedUp ? 'Saved this device’s chat key and ' : ''}${saved.existed ? 'updated' : 'saved'} ${plural(rows.length, 'message')} in your Google Drive app folder. The files are encrypted; the history needs this chat identity.${identityBackedUp ? '' : ' Unlock the wallet to include the chat-key recovery file.'}`);
    } catch (err) {
      setError(String(err?.message || 'The chat backup did not complete.'));
      setDialog(describeDriveFailure(err));
    } finally {
      setBusy(false);
    }
  }

  async function restoreNow({ replaceKey = false } = {}) {
    setBusy(true);
    setError('');
    setNote('');
    setKeyConflict(null);
    try {
      const token = await getDriveToken();
      let current = readChatIdentity(address) || chatIdentity;
      let identityRestored = false;
      if (session?.seed32) {
        const keyFile = await downloadBackup(token, { fileName: chatIdentityBackupFileName(address) });
        if (keyFile) {
          const recovered = await openChatIdentityBackup({
            walletSeed32: session.seed32, address, text: keyFile.text,
          });
          if (current && recovered.chatPub !== current.chatPub) {
            if (!replaceKey) {
              setKeyConflict(recovered);
              throw new Error('This device has a different chat key. Replace it only if you accept that history encrypted with the current key will stay unreadable here.');
            }
            current = recovered;
            if (!saveChatIdentity(current)) {
              throw new Error('The chat key was opened, but this browser could not store it.');
            }
            setChatIdentity(current);
            identityRestored = true;
          } else if (!current) {
            current = recovered;
            if (!saveChatIdentity(current)) {
              throw new Error('The chat key was opened, but this browser could not store it.');
            }
            setChatIdentity(current);
            identityRestored = true;
          }
        } else if (!current) {
          throw Object.assign(
            new Error('This wallet has no chat key backup in Google Drive yet.'),
            { code: 'NO_BACKUP' },
          );
        }
      } else if (!current) {
        throw new Error('Unlock the wallet once to restore this device’s chat key.');
      }
      if (session?.seed32) {
        await migrateChatData({ walletSeed32: session.seed32, chatIdentity: current, address });
      }
      const found = await downloadBackup(token, { fileName: archiveBackupFileName(address) });
      if (!found) {
        if (identityRestored) {
          setNote('Restored this device’s chat key. There is no chat history backup yet.');
          return;
        }
        throw Object.assign(
          new Error('This chat identity has no history backup in Google Drive yet.'),
          { code: 'NO_BACKUP' },
        );
      }
      const key = await deriveArchiveKey(current.seed32, address, 'chat');
      const opened = await openArchiveBackup(key, found.text, { address });
      const added = await restoreArchivedRows(address, opened.rows);
      setCount(await countArchivedMessages(address));
      setNote(`${identityRestored ? 'Restored this device’s chat key and ' : ''}restored ${plural(added, 'message')} from the Drive copy${opened.createdAt ? ` saved ${new Date(opened.createdAt).toLocaleString()}` : ''}. Messages already on this device were kept.`);
    } catch (err) {
      setError(String(err?.message || 'The chat restore did not complete.'));
      setDialog(describeDriveFailure(err));
    } finally {
      setBusy(false);
    }
  }

  const canUseDrive = configured && Boolean(address) && (unlocked || Boolean(session?.seed32));

  return (
    <section className="nw-card" aria-labelledby="nw-chat-archive-title">
      <h2 id="nw-chat-archive-title" style={{ color: 'var(--text)' }}>Chat history on this device</h2>
      <p className="nw-small nw-dim" style={{ margin: '8px 0 10px' }}>
        Off by default: messages live only while the tab is open, unless you press Keep on one. Turning
        this on keeps this wallet’s conversations on this device automatically, encrypted with a key
        derived from its chat identity — there is no extra password to remember. The encrypted chat-key
        backup is what makes a new device recoverable after this browser’s storage is cleared.
      </p>
      <p className="nw-small nw-dim" style={{ margin: '0 0 10px' }}>
        Pending payment requests are kept separately in the same encrypted local database, even
        when this history toggle is off. Deleting message history does not delete them.
      </p>
      {!address ? (
        <p className="nw-small nw-dim" role="status">Open a wallet to choose what to keep on this device.</p>
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
              disabled={busy || !canUseDrive || (count === 0 && !session?.seed32)}>
              {busy ? 'Working…' : 'Back up to Drive'}
            </button>
            <button type="button" className="nw-chip-btn" onClick={() => void restoreNow()}
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
              Open chat once on this device to read or back up saved messages. If this is a new
              device, unlock the wallet and restore the chat key from Drive first.
            </p>
          ) : null}
          {note ? <p className="nw-small nw-dim" role="status" style={{ margin: '8px 0 0' }}>{note}</p> : null}
          {error ? <p className="nw-small nw-google-error" role="alert" style={{ margin: '8px 0 0' }}>{error}</p> : null}
          {keyConflict ? (
            <div className="nw-btn-row" style={{ marginTop: 8 }} role="alert">
              <span className="nw-small nw-dim">
                The Drive chat key belongs to a different identity. Replacing this device’s key keeps
                local history encrypted with the old key unreadable here.
              </span>
              <button type="button" className="nw-chip-btn"
                disabled={busy}
                onClick={() => void restoreNow({ replaceKey: true })}>
                Replace chat key and restore
              </button>
            </div>
          ) : null}

          <details className="nw-small nw-dim" style={{ marginTop: 12 }}>
            <summary style={{ cursor: 'pointer' }}>What this does and does not protect</summary>
            <ul style={{ margin: '8px 0 0', paddingLeft: 18, display: 'grid', gap: 6 }}>
              <li>The message text is encrypted at rest with a key derived from this device’s chat identity; the device stores no plaintext and no second password.</li>
              <li>Who talked to whom and when stays readable on this device, and Google Drive sees the file’s size and timing — the same metadata the relay already sees.</li>
              <li>Anyone who has this browser profile, or who can run code on this page while chat is open, can read the archive.</li>
              <li>“Wipe when the wallet locks” deletes the records, but flash storage may keep old blocks until they are overwritten — it is not a forensic erase.</li>
              <li>The history Drive copy is encrypted with the same chat-identity key. The separate chat-key recovery file is encrypted with a key derived from the wallet seed, so a new device needs the wallet password once; an email login alone cannot open either file.</li>
            </ul>
          </details>
        </>
      )}

      <DriveFailureDialog dialog={dialog} onClose={() => setDialog(null)} />
    </section>
  );
}
