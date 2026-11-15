// How old the Drive copy of this device's wallets is.
//
// A stamp is written only when this browser actually finished an upload, and it
// is keyed by account so switching Google accounts cannot make a stale copy look
// fresh. It records a timestamp and nothing else: no address, balance, seed or
// key. Without it the wallet can only guess, and a restore that turns out to be
// months old is worse than being told beforehand.
import { normalizeAccount } from './walletBinding.js';

const KEY = 'scw-web-drive-backup-v1';
const DAY_MS = 24 * 60 * 60 * 1000;

/** A funded wallet whose last Drive upload is older than this gets a reminder. */
export const REMINDER_DAYS = 7;

function read() {
  if (typeof localStorage === 'undefined') return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function write(map) {
  if (typeof localStorage === 'undefined') return false;
  try {
    if (Object.keys(map).length) localStorage.setItem(KEY, JSON.stringify(map));
    else localStorage.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}

/** Remember that `account`'s encrypted keystore reached Drive at `at`. */
export function recordDriveBackup(account, at = new Date()) {
  const email = normalizeAccount(account);
  const when = at instanceof Date ? at : new Date(at);
  if (!email || Number.isNaN(when.getTime())) return false;
  const map = read();
  map[email] = when.toISOString();
  return write(map);
}

/** ISO time of the last upload recorded for `account` here, or ''. */
export function lastDriveBackup(account) {
  const email = normalizeAccount(account);
  if (!email) return '';
  const stored = read()[email];
  return typeof stored === 'string' ? stored : '';
}

// An empty, unknown or non-numeric balance has nothing to lose yet, so it must
// never produce a nag.
function holdsValue(balance) {
  const value = String(balance ?? '').trim();
  return /^\d+$/.test(value) && BigInt(value) > 0n;
}

/**
 * Whether the home screen should ask for a backup, and how old the last one is.
 * `ageDays` is null when this device has no record of an upload at all, which
 * counts as due: a lost device would then leave nothing to restore.
 */
export function backupReminder({ balance, lastBackupAt, now = Date.now(), days = REMINDER_DAYS }) {
  if (!holdsValue(balance)) return { due: false, ageDays: null };
  const stamp = lastBackupAt ? new Date(lastBackupAt).getTime() : NaN;
  if (Number.isNaN(stamp)) return { due: true, ageDays: null };
  // A clock that jumped backwards must not produce a negative age or a false alarm.
  const ageDays = Math.max(0, Math.floor((now - stamp) / DAY_MS));
  return { due: ageDays >= days, ageDays };
}
