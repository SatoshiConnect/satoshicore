// Encrypted wallet backup in the account's own Google Drive.
//
// SECURITY MODEL:
//  - The only thing uploaded is the existing keystore ciphertext: per-wallet
//    AES-256-GCM (PBKDF2-HMAC-SHA256, 600k iterations). The wallet password
//    never leaves this device, so Google — and this site's servers — cannot
//    open the backup. Restoring on another device still asks for the wallet
//    password, because that is the only key.
//  - The OAuth access token is held in memory only, never persisted, logged or
//    put in a URL. Drive access is requested with the narrow `drive.appdata`
//    scope: one app-private folder the site can create files in, and nothing
//    else in the user's Drive.
//  - The envelope records which account produced it so a signed-in account
//    cannot restore (and then claim) another account's backup, and a SHA-256 of
//    the ciphertext so a corrupted upload is refused before it replaces the
//    local keystore.
//
// Everything above the thin Drive fetch layer is pure and unit-tested in
// tests/drive-backup.test.mjs.
import { getFirebaseWebConfig, loadGoogleAuth } from './firebaseAuth.js';

export const BACKUP_FILENAME = 'nsat-wallet-backup.json';
export const BACKUP_APP = 'satoshicore-wallet';
export const BACKUP_VERSION = 1;
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

// ---------------- pure envelope ----------------
const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return toHex(new Uint8Array(digest));
}

export function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Wrap the keystore ciphertext for upload. The keystore blob stays byte-for-byte
 * identical — this only adds the account binding and an integrity hash.
 */
export async function buildBackup(keystoreBlob, { email, savedAt = new Date().toISOString() } = {}) {
  if (typeof keystoreBlob !== 'string' || !keystoreBlob.trim()) {
    throw fail('There is no encrypted keystore on this device to back up.', 'NO_KEYSTORE');
  }
  const account = normalizeEmail(email);
  if (!account) throw fail('Sign in with Google before backing up to Drive.', 'NOT_SIGNED_IN');
  return {
    v: BACKUP_VERSION,
    app: BACKUP_APP,
    account,
    savedAt,
    sha256: await sha256Hex(keystoreBlob),
    keystore: keystoreBlob,
  };
}

/**
 * Validate a downloaded backup before anything is installed locally.
 * Refuses wrong app/version, a different account, and any byte that does not
 * match the recorded hash.
 */
export async function parseBackup(text, { email } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(String(text ?? ''));
  } catch {
    throw fail('That Drive file is not a SatoshiCore wallet backup.', 'BACKUP_INVALID');
  }
  if (!parsed || typeof parsed !== 'object') throw fail('That Drive file is not a SatoshiCore wallet backup.', 'BACKUP_INVALID');
  if (parsed.v !== BACKUP_VERSION || parsed.app !== BACKUP_APP) {
    throw fail('That Drive file was not written by this wallet app version.', 'BACKUP_INVALID');
  }
  const account = normalizeEmail(parsed.account);
  if (!account) throw fail('That backup does not name the account it belongs to.', 'BACKUP_INVALID');
  const signedIn = normalizeEmail(email);
  if (!signedIn) throw fail('Sign in with Google before restoring from Drive.', 'NOT_SIGNED_IN');
  if (account !== signedIn) {
    throw fail(`That backup belongs to ${account}, not to the account signed in on this device.`, 'ACCOUNT_MISMATCH');
  }
  if (typeof parsed.keystore !== 'string' || !parsed.keystore.trim()) {
    throw fail('That backup contains no encrypted wallet data.', 'BACKUP_INVALID');
  }
  const expected = typeof parsed.sha256 === 'string' ? parsed.sha256.toLowerCase() : '';
  const actual = await sha256Hex(parsed.keystore);
  if (expected !== actual) {
    throw fail('The backup does not match its own checksum, so it was not restored.', 'BACKUP_INVALID');
  }
  // A payload must look like a keystore envelope before the caller stores it.
  let inner;
  try {
    inner = JSON.parse(parsed.keystore);
  } catch {
    throw fail('The encrypted wallet data in that backup is unreadable.', 'BACKUP_INVALID');
  }
  if (!inner || inner.v !== 1 || !Array.isArray(inner.wallets) || inner.wallets.length === 0) {
    throw fail('The encrypted wallet data in that backup is unreadable.', 'BACKUP_INVALID');
  }
  return {
    account,
    savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : '',
    wallets: inner.wallets.length,
    keystore: parsed.keystore,
  };
}

// ---------------- failure reporting --------------
// Every failure carries a code so the UI can show one clear popup instead of a
// raw Google message. `fix` is the one action that actually resolves it.
function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const projectId = () => getFirebaseWebConfig().projectId || '';
const DRIVE_API_URL = () => `https://console.cloud.google.com/apis/library/drive.googleapis.com${projectId() ? `?project=${projectId()}` : ''}`;
const CONSENT_URL = () => `https://console.cloud.google.com/apis/credentials/consent${projectId() ? `?project=${projectId()}` : ''}`;

/**
 * Turn any Drive-backup failure into what the popup shows: a title, a plain
 * explanation, and (when the user can fix it) a link that opens the page where
 * the fix lives. Pure so the mapping itself is unit-tested.
 */
// Firebase reports its own failures as `Firebase: Error (auth/<code>).` and,
// for a Google 403 raised inside the popup, it buries the Drive message in the
// code itself. Both are unreadable on screen, so they are mapped here too.
function failureCode(error) {
  const raw = String(error?.message || error || '');
  if (/drive-api-has-not-been-used/i.test(raw)) return 'DRIVE_API_DISABLED';
  if (/permission denied on the service/i.test(raw)) return 'DRIVE_API_DISABLED';
  const match = raw.match(/\((auth\/[a-z0-9-]+?)\.?\)/i);
  return error?.code || (match ? match[1] : '');
}

function cleanMessage(raw) {
  return raw.replace(/^Firebase:\s*Error\s*\((.*?)\)\.?$/i, '$1');
}

export function describeDriveFailure(error) {
  const raw = String(error?.message || error || '');
  const message = cleanMessage(raw) || 'The Drive backup did not complete.';
  const code = failureCode(error);
  switch (code) {
    case 'DRIVE_API_DISABLED':
      return {
        title: 'Google Drive API is turned off',
        message: 'Google refused this request because the Drive API is not enabled for this site’s project. The backup never left the browser.',
        fix: { label: 'Enable the Drive API', url: DRIVE_API_URL() },
        tone: 'err',
      };
    case 'DRIVE_REFUSED':
      return {
        title: 'Google refused Drive access',
        message: 'The account did not grant the drive.appdata scope, or the OAuth consent screen does not include it yet. Nothing was uploaded.',
        fix: { label: 'Check the consent screen', url: CONSENT_URL() },
        tone: 'err',
      };
    case 'TOKEN_EXPIRED':
      return {
        title: 'Drive access expired',
        message: 'The Google session no longer allows Drive. Press “Back up to Drive” again and approve the Google window.',
        tone: 'warn',
      };
    case 'TOKEN_MISSING':
    case 'NOT_SIGNED_IN':
      return {
        title: 'Google Drive access is missing',
        message, fix: { label: 'Check the consent screen', url: CONSENT_URL() }, tone: 'warn',
      };
    case 'NO_BACKUP':
      return {
        title: 'Nothing to restore yet',
        message: 'This account has no wallet backup in Google Drive. Create or import a wallet here, then press “Back up to Drive”.',
        tone: 'warn',
      };
    case 'ACCOUNT_MISMATCH':
      return {
        title: 'That backup belongs to another account',
        message,
        tone: 'err',
      };
    case 'BACKUP_INVALID':
      return {
        title: 'That backup cannot be used',
        message, tone: 'err',
      };
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return {
        title: 'The Google window was closed',
        message: 'Nothing was sent to Drive. Press “Back up to Drive” again and finish the Google window to allow it.',
        tone: 'warn',
      };
    case 'auth/popup-blocked':
      return {
        title: 'The browser blocked the Google window',
        message: 'Allow pop-ups for this site, then press “Back up to Drive” again.',
        tone: 'err',
      };
    case 'auth/network-request-failed':
      return {
        title: 'Google could not be reached',
        message: 'The network dropped the Google sign-in. Check the connection and try again.',
        tone: 'warn',
      };
    case 'auth/unauthorized-domain':
      return {
        title: 'This domain is not allowed to sign in',
        message: `Google sign-in is allowed only from domains listed in the Firebase project. Add ${typeof location !== 'undefined' ? location.host : 'this site'} to the authorized domains.`,
        fix: { label: 'Open authentication settings', url: `https://console.firebase.google.com/project/${projectId() || '_'}/authentication/settings` },
        tone: 'err',
      };
    case 'auth/operation-not-allowed':
      return {
        title: 'Google sign-in is turned off',
        message: 'The Google provider is disabled for this project. Enable it under Sign-in method.',
        fix: { label: 'Open sign-in method', url: `https://console.firebase.google.com/project/${projectId() || '_'}/authentication/providers` },
        tone: 'err',
      };
    default:
      return {
        title: 'Drive backup did not complete',
        message,
        tone: 'err',
      };
  }
}

// ---------------- access token ----------------
// One token per page load, refreshed lazily. Nothing is written to storage: a
// reload drops it, and an expiring token simply triggers one more consent-free
// popup from an already signed-in session.
let cachedToken = null;

export function forgetDriveToken() {
  cachedToken = null;
}

export async function getDriveToken({ interactive = true } = {}) {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.token;
  if (!interactive) throw fail('Google Drive needs your approval in a Google window before it can be used.', 'TOKEN_MISSING');
  const { auth, authSdk } = await loadGoogleAuth();
  // reauthenticateWithPopup() takes the signed-in USER, not the Auth instance:
  // it reads user.auth.app internally, so passing Auth fails with
  // "Cannot read properties of undefined (reading 'app')".
  const user = auth.currentUser;
  if (!user) throw fail('Sign in with Google first, then use Drive backup.', 'NOT_SIGNED_IN');
  const provider = new authSdk.GoogleAuthProvider();
  provider.addScope(DRIVE_SCOPE);
  const result = await authSdk.reauthenticateWithPopup(user, provider);
  const credential = authSdk.GoogleAuthProvider.credentialFromResult(result);
  const token = credential?.accessToken;
  if (!token) {
    throw fail('Google did not return Drive access. Enable the Google Drive API and the drive.appdata scope for this OAuth client.', 'TOKEN_MISSING');
  }
  cachedToken = { token, expiresAt: Date.now() + 50 * 60 * 1000 };
  return token;
}

// ---------------- Drive file operations ----------------
async function driveError(response, action) {
  let detail = '';
  try {
    const body = await response.json();
    detail = body?.error?.message || '';
  } catch { /* body is optional */ }
  if (response.status === 401) return fail('Drive access expired. Approve the Google window again.', 'TOKEN_EXPIRED');
  if (response.status === 403) {
    return detail.includes('has not been used')
      ? fail('Google Drive API is not enabled for this project yet.', 'DRIVE_API_DISABLED')
      : fail('Google refused Drive access for this account.', 'DRIVE_REFUSED');
  }
  return fail(`${action} failed${detail ? `: ${detail}` : ` (HTTP ${response.status})`}.`, 'DRIVE_REQUEST_FAILED');
}

async function findBackupFile(token, doFetch) {
  const params = new URLSearchParams({
    spaces: 'appDataFolder',
    q: `name='${BACKUP_FILENAME}' and trashed=false`,
    fields: 'files(id,modifiedTime,size)',
    pageSize: '1',
  });
  const response = await doFetch(`${DRIVE_API}/files?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw await driveError(response, 'Looking for the backup');
  const body = await response.json();
  const file = body?.files?.[0];
  return file ? { id: file.id, modifiedTime: file.modifiedTime || '' } : null;
}

/** Create or overwrite the single backup file. Returns { modifiedTime, existed }. */
export async function uploadBackup(token, text, { doFetch = globalThis.fetch } = {}) {
  const existing = await findBackupFile(token, doFetch);
  if (existing) {
    const response = await doFetch(`${DRIVE_UPLOAD}/files/${encodeURIComponent(existing.id)}?uploadType=media`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: text,
    });
    if (!response.ok) throw await driveError(response, 'Updating the Drive backup');
    const updated = await response.json().catch(() => ({}));
    return { existed: true, modifiedTime: updated.modifiedTime || new Date().toISOString() };
  }
  const response = await doFetch(`${DRIVE_UPLOAD}/files?uploadType=multipart`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'multipart/related; boundary=nsat-backup' },
    body: [
      '--nsat-backup',
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify({ name: BACKUP_FILENAME, parents: ['appDataFolder'], mimeType: 'application/json' }),
      '--nsat-backup',
      'Content-Type: application/json',
      '',
      text,
      '--nsat-backup--',
      '',
    ].join('\r\n'),
  });
  if (!response.ok) throw await driveError(response, 'Uploading the Drive backup');
  const created = await response.json().catch(() => ({}));
  return { existed: false, modifiedTime: created.modifiedTime || new Date().toISOString() };
}

/**
 * Refresh an existing backup without any new consent prompt. Only runs when this
 * page load already has Drive access, so creating a wallet never opens a Google
 * window on its own; without a token the caller leaves the manual button to the
 * user. Returns { backedUp, email, modifiedTime } where email is '' when nothing
 * happened.
 */
export async function backupSilently(keystoreBlob, { doFetch = globalThis.fetch } = {}) {
  if (!cachedToken || cachedToken.expiresAt <= Date.now() + 30_000) {
    return { backedUp: false, email: '', modifiedTime: '' };
  }
  const { auth } = await loadGoogleAuth();
  const email = normalizeEmail(auth.currentUser?.email);
  if (!email) return { backedUp: false, email: '', modifiedTime: '' };
  const envelope = await buildBackup(keystoreBlob, { email });
  const saved = await uploadBackup(cachedToken.token, JSON.stringify(envelope), { doFetch });
  return { backedUp: true, email, modifiedTime: saved.modifiedTime };
}

/** Read the backup text, or null when the account has never backed up. */
export async function downloadBackup(token, { doFetch = globalThis.fetch } = {}) {
  const existing = await findBackupFile(token, doFetch);
  if (!existing) return null;
  const response = await doFetch(`${DRIVE_API}/files/${encodeURIComponent(existing.id)}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw await driveError(response, 'Downloading the Drive backup');
  return { text: await response.text(), modifiedTime: existing.modifiedTime };
}
