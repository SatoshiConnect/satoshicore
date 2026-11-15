'use client';

// Encrypted wallet backup in the signed-in account's own Google Drive.
//
// What leaves the device is the keystore ciphertext and nothing else: each
// wallet is already AES-256-GCM encrypted under its own password (PBKDF2-
// SHA256, 600k iterations). Google and this site cannot open the file, and a
// restore on another device still asks for the wallet password. The Drive
// token lives in memory for the page load only.
import { useEffect, useState } from 'react';
import {
  isFirebaseWebConfigured, loadGoogleAuth,
} from '../lib/firebaseAuth';
import { recordDriveBackup } from '../lib/backupReminder';
import DriveFailureDialog from './DriveFailureDialog';
import {
  keystoreExport, keystoreList, keystoreRestore,
} from '../lib/nsatWallet';
import {
  buildBackup, describeDriveFailure, downloadBackup, getDriveToken, parseBackup,
  uploadBackup,
} from '../lib/driveBackup';
import {
  bindOwner, normalizeAccount, ownerOf,
} from '../lib/walletBinding';

const configured = isFirebaseWebConfigured();

export default function DriveBackupCard({ onKeystoreChanged } = {}) {
  const [email, setEmail] = useState('');
  const [wallets, setWallets] = useState([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  // A download that would replace wallets already on this device needs a
  // second, explicit click: overwriting the local keystore cannot be undone.
  const [pendingRestore, setPendingRestore] = useState(null);
  // Anything that stops a backup or restore opens this dialog instead of a
  // quiet line: it states what failed and, when the user can act, links to the
  // exact page that fixes it.
  const [dialog, setDialog] = useState(null);

  useEffect(() => {
    setWallets(keystoreList());
  }, []);

  useEffect(() => {
    if (!configured) return undefined;
    let mounted = true;
    let unsubscribe = () => {};
    loadGoogleAuth().then(({ auth, authSdk }) => {
      if (!mounted) return;
      unsubscribe = authSdk.onAuthStateChanged(auth, (user) => {
        setEmail(user?.email || '');
        setWallets(keystoreList());
      });
    }).catch(() => { /* sign-in unavailable: the card stays informative */ });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const boundElsewhere = wallets.filter((wallet) => {
    const owner = ownerOf(wallet.name);
    return owner && owner !== normalizeAccount(email);
  });

  function refreshWallets() {
    setWallets(keystoreList());
    onKeystoreChanged?.();
  }

  // The always-available escape hatch: the same encrypted keystore, saved as a
  // file, needs no Google API at all.
  function downloadEncryptedBackup() {
    const blob = keystoreExport();
    if (!blob) {
      setDialog(describeDriveFailure({ code: 'NO_KEYSTORE', message: 'There is no wallet on this device to export yet.' }));
      return;
    }
    const url = URL.createObjectURL(new Blob([blob], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'scw-web-backup.json';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    setDialog(null);
    setNote('Saved the encrypted keystore file to this device. Opening it still needs your wallet password.');
  }

  async function backupNow() {
    setBusy(true);
    setError('');
    setNote('');
    try {
      if (boundElsewhere.length) {
        throw Object.assign(
          new Error(`“${boundElsewhere[0].name}” on this device is bound to ${ownerOf(boundElsewhere[0].name)}. Sign in with that account to back it up.`),
          { code: 'ACCOUNT_MISMATCH' },
        );
      }
      const token = await getDriveToken();
      const envelope = await buildBackup(keystoreExport(), { email });
      const saved = await uploadBackup(token, JSON.stringify(envelope));
      for (const wallet of keystoreList()) bindOwner(wallet.name, email);
      setWallets(keystoreList());
      // The home screen reads this to decide when the copy is too old to trust.
      recordDriveBackup(email, saved.modifiedTime ? new Date(saved.modifiedTime) : new Date());
      setNote(`${saved.existed ? 'Updated' : 'Saved'} the encrypted backup in Google Drive at ${new Date(saved.modifiedTime).toLocaleString()}. Opening it still needs the wallet password.`);
    } catch (err) {
      setError(String(err?.message || 'The Drive backup did not complete.'));
      setDialog(describeDriveFailure(err));
    } finally {
      setBusy(false);
    }
  }

  async function installBackup(parsed) {
    keystoreRestore(parsed.keystore);
    for (const wallet of keystoreList()) bindOwner(wallet.name, email);
    refreshWallets();
    setPendingRestore(null);
    setNote(`Restored ${parsed.wallets} wallet(s) from Google Drive — unlock with its password.`);
  }

  async function restoreNow() {
    setBusy(true);
    setError('');
    try {
      if (pendingRestore) {
        await installBackup(pendingRestore);
        return;
      }
      setNote('');
      const token = await getDriveToken();
      const found = await downloadBackup(token);
      if (!found) {
        throw Object.assign(new Error('This account has no wallet backup in Google Drive yet.'), { code: 'NO_BACKUP' });
      }
      const parsed = await parseBackup(found.text, { email });
      if (keystoreList().length === 0) {
        await installBackup(parsed);
      } else {
        setPendingRestore(parsed);
        setNote(`Found a backup with ${parsed.wallets} wallet(s)${parsed.savedAt ? ` saved ${new Date(parsed.savedAt).toLocaleString()}` : ''}. Replacing this device’s wallets cannot be undone — press “Replace with this backup” to continue.`);
      }
    } catch (err) {
      setError(String(err?.message || 'The restore did not complete.'));
      setDialog(describeDriveFailure(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="nw-card" aria-labelledby="nw-drive-backup-title">
      <h2 id="nw-drive-backup-title" style={{ color: 'var(--text)' }}>Wallet backup</h2>
      <p className="nw-small nw-dim" style={{ margin: '8px 0 12px' }}>
        {'Signing in with Google above identifies your session only; this backup is a separate, '
          + 'optional step. It keeps this device’s wallets in a private app folder of your own '
          + 'Google Drive, already encrypted with each wallet’s password. Google and this site '
          + 'cannot open it, and restoring on another device still asks for that password — so an '
          + 'email login alone can never move funds.'}
      </p>
      {!configured ? (
        <p className="nw-small nw-dim" role="status">Google sign-in is not configured in this build.</p>
      ) : !email ? (
        <p className="nw-small nw-dim" role="status">
          Sign in with Google above to enable Drive backup. Wallets stay on this device until then.
        </p>
      ) : null}
      {wallets.length ? (
        <div className="nw-kv">
          <span className="nw-k">Bound account</span>
          <span className="nw-v nw-small">
            {wallets.map((wallet) => `${wallet.name} → ${ownerOf(wallet.name) || 'not bound yet'}`).join(' · ')}
          </span>
        </div>
      ) : (
        <p className="nw-small nw-dim" style={{ margin: '6px 0' }}>
          No wallet on this device yet — create or import one, then back it up here.
        </p>
      )}
      {boundElsewhere.length ? (
        <p className="nw-small nw-google-error" role="alert">
          {`“${boundElsewhere[0].name}” belongs to ${ownerOf(boundElsewhere[0].name)}. Sign in with that account to back it up or restore it.`}
        </p>
      ) : null}
      <div className="nw-btn-row" style={{ margin: '10px 0 0' }}>
        <button type="button" className="nw-chip-btn" onClick={backupNow}
          disabled={busy || !email || wallets.length === 0 || boundElsewhere.length > 0}>
          {busy ? 'Working…' : 'Back up to Drive'}
        </button>
        <button type="button" className="nw-chip-btn" onClick={restoreNow}
          disabled={busy || !email}>
          {pendingRestore ? 'Replace with this backup' : 'Restore from Drive'}
        </button>
        {pendingRestore ? (
          <button type="button" className="nw-chip-btn" disabled={busy}
            onClick={() => { setPendingRestore(null); setNote('Restore cancelled — this device’s wallets are unchanged.'); }}>
            Cancel
          </button>
        ) : null}
      </div>
      {note ? <p className="nw-small nw-dim" role="status" style={{ margin: '8px 0 0' }}>{note}</p> : null}
      {error ? <p className="nw-small nw-google-error" role="alert" style={{ margin: '8px 0 0' }}>{error}</p> : null}
      {!busy && wallets.length && email ? (
        <p className="nw-small nw-dim" style={{ margin: '10px 0 0' }}>
          No Google Drive? You can still{' '}
          <button type="button" className="nw-linklike" onClick={downloadEncryptedBackup}>
            save the encrypted backup as a file
          </button>
          {' '}and keep it somewhere safe.
        </p>
      ) : null}

      <DriveFailureDialog dialog={dialog} onClose={() => setDialog(null)}
        onDownload={downloadEncryptedBackup} canDownload={wallets.length > 0} />
    </section>
  );
}
