'use client';

// "This wallet holds money and its encrypted Drive copy is stale."
//
// Losing the device is the one failure a wallet cannot undo, and an account
// login alone never restores funds — the encrypted copy does. The reminder
// appears only for a funded wallet whose last upload this browser recorded, or
// that was never uploaded at all, and its button finishes a real upload instead
// of pointing at Settings.
import { useEffect, useState } from 'react';
import {
  isFirebaseWebConfigured, loadGoogleAuth,
} from '../lib/firebaseAuth';
import { keystoreExport, keystoreList } from '../lib/nsatWallet';
import {
  buildBackup, describeDriveFailure, getDriveToken, uploadBackup,
} from '../lib/driveBackup';
import {
  bindOwner, normalizeAccount, ownerOf,
} from '../lib/walletBinding';
import {
  backupReminder, coveredWallets, lastDriveBackup, recordDriveBackup,
} from '../lib/backupReminder';
import { formatExactBalance } from '../lib/nsatClient';
import DriveFailureDialog from './DriveFailureDialog';

export default function BackupReminder({ balance, email, notify, onBackedUp }) {
  // "Later" is a page-load dismissal, never a snooze: the next visit asks again,
  // because the risk is the same tomorrow.
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lastAt, setLastAt] = useState('');
  const [covered, setCovered] = useState([]);
  const [dialog, setDialog] = useState(null);
  const [note, setNote] = useState('');

  useEffect(() => {
    setLastAt(lastDriveBackup(email));
    setCovered(coveredWallets(email));
  }, [email]);

  async function backUpNow() {
    setBusy(true);
    setNote('');
    try {
      const wallets = keystoreList();
      if (!wallets.length) return;
      const blocked = wallets.find((wallet) => {
        const owner = ownerOf(wallet.name);
        return owner && owner !== normalizeAccount(email);
      });
      if (blocked) {
        throw Object.assign(
          new Error(`“${blocked.name}” on this device is bound to ${ownerOf(blocked.name)}. Sign in with that account to back it up.`),
          { code: 'ACCOUNT_MISMATCH' },
        );
      }
      // The Google window is what may still be missing, so ask for it first and
      // read the account from the fresh session rather than the page's copy.
      const token = await getDriveToken();
      const { auth } = await loadGoogleAuth();
      const account = normalizeAccount(auth.currentUser?.email || email);
      if (!account) {
        throw Object.assign(new Error('Sign in with Google first, then use Drive backup.'), { code: 'NOT_SIGNED_IN' });
      }
      const envelope = await buildBackup(keystoreExport(), { email: account });
      const saved = await uploadBackup(token, JSON.stringify(envelope));
      for (const wallet of keystoreList()) bindOwner(wallet.name, account);
      recordDriveBackup(account, saved.modifiedTime ? new Date(saved.modifiedTime) : new Date(), {
        wallets: keystoreList().map((wallet) => wallet.pubkey),
      });
      setLastAt(lastDriveBackup(account));
      setCovered(coveredWallets(account));
      setNote(`Saved the encrypted backup in Google Drive at ${new Date(saved.modifiedTime).toLocaleString()}.`);
      notify?.('Encrypted backup updated in Google Drive.', 'ok');
      onBackedUp?.();
    } catch (err) {
      setDialog(describeDriveFailure(err));
    } finally {
      setBusy(false);
    }
  }

  if (!isFirebaseWebConfigured()) return null;
  // A wallet added after the last upload is not in the Drive copy, however
  // recent that upload was.
  const uncoveredNames = covered.length
    ? keystoreList().filter((wallet) => !covered.includes(wallet.pubkey)).map((wallet) => wallet.name)
    : [];
  const { due, ageDays, newWalletNames } = backupReminder({
    balance, lastBackupAt: lastAt, newWalletNames: uncoveredNames,
  });
  if (!due || dismissed) return null;
  const ageText = ageDays == null ? '' : ` (last copy ${ageDays} day${ageDays === 1 ? '' : 's'} old)`;

  return (
    <section className="nw-card nw-backup-remind" aria-labelledby="nw-backup-remind-title">
      <h2 id="nw-backup-remind-title" style={{ color: 'var(--text)' }}>Back up this wallet</h2>
      <p className="nw-small nw-dim" style={{ margin: '8px 0 12px' }}>
        {`This wallet holds ${formatExactBalance(balance)} NSAT, but its encrypted copy in Google Drive `}
        {newWalletNames.length
          ? `${newWalletNames.length === 1 ? `“${newWalletNames[0]}” was` : `${newWalletNames.map((name) => `“${name}”`).join(', ')} were`} added to this device after the last Drive copy${ageText}. A lost device would lose ${newWalletNames.length === 1 ? 'it' : 'them'}, and the account alone cannot recover ${newWalletNames.length === 1 ? 'it' : 'them'}.`
          : ageDays == null
            ? 'has not been made yet. A lost device would leave nothing to restore, and the account alone cannot move funds.'
            : `was last updated ${ageDays} day${ageDays === 1 ? '' : 's'} ago. If this device is lost, anything sent since then cannot be recovered.`}
      </p>
      <div className="nw-btn-row">
        <button type="button" className="nw-send-btn" onClick={backUpNow} disabled={busy}>
          {busy ? 'Backing up…' : 'Back up now'}
        </button>
        <button type="button" className="nw-chip-btn" onClick={() => setDismissed(true)} disabled={busy}>
          Later
        </button>
      </div>
      {note ? <p className="nw-small nw-dim" role="status" style={{ margin: '8px 0 0' }}>{note}</p> : null}
      <DriveFailureDialog dialog={dialog} onClose={() => setDialog(null)} />
    </section>
  );
}
