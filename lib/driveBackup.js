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
import { loadGoogleAuth } from './firebaseAuth.js';

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
    throw new Error('There is no encrypted keystore on this device to back up.');
  }
  const account = normalizeEmail(email);
  if (!account) throw new Error('Sign in with Google before backing up to Drive.');
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
    throw new Error('That Drive file is not a SatoshiCore wallet backup.');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('That Drive file is not a SatoshiCore wallet backup.');
  if (parsed.v !== BACKUP_VERSION || parsed.app !== BACKUP_APP) {
    throw new Error('That Drive file was not written by this wallet app version.');
  }
  const account = normalizeEmail(parsed.account);
  if (!account) throw new Error('That backup does not name the account it belongs to.');
  const signedIn = normalizeEmail(email);
  if (!signedIn) throw new Error('Sign in with Google before restoring from Drive.');
  if (account !== signedIn) {
    throw new Error(`That backup belongs to ${account}, not to the account signed in on this device.`);
  }
  if (typeof parsed.keystore !== 'string' || !parsed.keystore.trim()) {
    throw new Error('That backup contains no encrypted wallet data.');
  }
  const expected = typeof parsed.sha256 === 'string' ? parsed.sha256.toLowerCase() : '';
  const actual = await sha256Hex(parsed.keystore);
  if (expected !== actual) {
    throw new Error('The backup does not match its own checksum, so it was not restored.');
  }
  // A payload must look like a keystore envelope before the caller stores it.
  let inner;
  try {
    inner = JSON.parse(parsed.keystore);
  } catch {
    throw new Error('The encrypted wallet data in that backup is unreadable.');
  }
  if (!inner || inner.v !== 1 || !Array.isArray(inner.wallets) || inner.wallets.length === 0) {
    throw new Error('The encrypted wallet data in that backup is unreadable.');
  }
  return {
    account,
    savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : '',
    wallets: inner.wallets.length,
    keystore: parsed.keystore,
  };
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
  if (!interactive) throw new Error('Google Drive needs your approval in a Google window before it can be used.');
  const { auth, authSdk } = await loadGoogleAuth();
  // reauthenticateWithPopup() takes the signed-in USER, not the Auth instance:
  // it reads user.auth.app internally, so passing Auth fails with
  // "Cannot read properties of undefined (reading 'app')".
  const user = auth.currentUser;
  if (!user) throw new Error('Sign in with Google first, then use Drive backup.');
  const provider = new authSdk.GoogleAuthProvider();
  provider.addScope(DRIVE_SCOPE);
  const result = await authSdk.reauthenticateWithPopup(user, provider);
  const credential = authSdk.GoogleAuthProvider.credentialFromResult(result);
  const token = credential?.accessToken;
  if (!token) {
    throw new Error('Google did not return Drive access. Enable the Google Drive API and the drive.appdata scope for this OAuth client.');
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
  if (response.status === 401) return new Error('Drive access expired. Approve the Google window again.');
  if (response.status === 403) {
    return new Error(detail.includes('has not been used')
      ? 'Google Drive API is not enabled for this project yet.'
      : 'Google refused Drive access for this account.');
  }
  return new Error(`${action} failed${detail ? `: ${detail}` : ` (HTTP ${response.status})`}.`);
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
 * user. Returns { backedUp, email } where email is '' when nothing happened.
 */
export async function backupSilently(keystoreBlob, { doFetch = globalThis.fetch } = {}) {
  if (!cachedToken || cachedToken.expiresAt <= Date.now() + 30_000) return { backedUp: false, email: '' };
  const { auth } = await loadGoogleAuth();
  const email = normalizeEmail(auth.currentUser?.email);
  if (!email) return { backedUp: false, email: '' };
  const envelope = await buildBackup(keystoreBlob, { email });
  await uploadBackup(cachedToken.token, JSON.stringify(envelope), { doFetch });
  return { backedUp: true, email };
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
