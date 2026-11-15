// Encrypted Google Drive backup: envelope integrity, account binding, and the
// exact Drive requests the browser makes. No network: the fetch layer is
// injected, and every case asserts a refusal path the restore UI depends on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  BACKUP_APP, BACKUP_FILENAME, BACKUP_VERSION, buildBackup, describeDriveFailure,
  downloadBackup, parseBackup, sha256Hex, uploadBackup,
} from '../lib/driveBackup.js';

const KEYSTORE = JSON.stringify({
  v: 1,
  wallets: [{
    name: 'Primary',
    pubkey: `G${'A'.repeat(55)}`,
    kdf: { algo: 'PBKDF2-HMAC-SHA256', salt: 'c2FsdA==', iterations: 600000 },
    nonce: 'bm9uY2U=',
    box: 'ciphertext',
    aead: 'AES-GCM-256',
  }],
});

test('buildBackup records the account, the checksum and the untouched ciphertext', async () => {
  const envelope = await buildBackup(KEYSTORE, { email: '  User@Example.com ' });
  assert.equal(envelope.v, BACKUP_VERSION);
  assert.equal(envelope.app, BACKUP_APP);
  assert.equal(envelope.account, 'user@example.com');
  assert.equal(envelope.keystore, KEYSTORE);
  assert.equal(envelope.sha256, await sha256Hex(KEYSTORE));
});

test('buildBackup refuses an empty keystore or a missing account', async () => {
  await assert.rejects(() => buildBackup('', { email: 'a@b.c' }), /no encrypted keystore/i);
  await assert.rejects(() => buildBackup('   ', { email: 'a@b.c' }), /no encrypted keystore/i);
  await assert.rejects(() => buildBackup(KEYSTORE, { email: '  ' }), /sign in with google/i);
});

test('parseBackup round-trips the ciphertext for the same account', async () => {
  const envelope = await buildBackup(KEYSTORE, { email: 'user@example.com', savedAt: '2026-01-02T03:04:05.000Z' });
  const parsed = await parseBackup(JSON.stringify(envelope), { email: 'USER@example.com' });
  assert.equal(parsed.keystore, KEYSTORE);
  assert.equal(parsed.account, 'user@example.com');
  assert.equal(parsed.savedAt, '2026-01-02T03:04:05.000Z');
  assert.equal(parsed.wallets, 1);
});

test('a backup from another account is refused before it can be installed', async () => {
  const envelope = await buildBackup(KEYSTORE, { email: 'owner@example.com' });
  await assert.rejects(
    () => parseBackup(JSON.stringify(envelope), { email: 'other@example.com' }),
    /belongs to owner@example\.com/i,
  );
  await assert.rejects(() => parseBackup(JSON.stringify(envelope), { email: '' }), /sign in with google/i);
});

test('a tampered or corrupted keystore is refused by the checksum', async () => {
  const envelope = await buildBackup(KEYSTORE, { email: 'user@example.com' });
  const swapped = { ...envelope, keystore: envelope.keystore.replace('ciphertext', 'ciphertexT') };
  await assert.rejects(() => parseBackup(JSON.stringify(swapped), { email: 'user@example.com' }), /checksum/i);

  const noHash = { ...envelope, sha256: '' };
  await assert.rejects(() => parseBackup(JSON.stringify(noHash), { email: 'user@example.com' }), /checksum/i);
});

test('malformed files are rejected with a usable message', async () => {
  await assert.rejects(() => parseBackup('not json', { email: 'a@b.c' }), /not a SatoshiCore wallet backup/i);
  await assert.rejects(
    () => parseBackup(JSON.stringify({ v: 99, app: BACKUP_APP }), { email: 'a@b.c' }),
    /not written by this wallet app/i,
  );
  await assert.rejects(
    () => parseBackup(JSON.stringify({ v: BACKUP_VERSION, app: 'other-app' }), { email: 'a@b.c' }),
    /not written by this wallet app/i,
  );

  const noAccount = await buildBackup(KEYSTORE, { email: 'a@b.c' });
  await assert.rejects(
    () => parseBackup(JSON.stringify({ ...noAccount, account: '' }), { email: 'a@b.c' }),
    /does not name the account/i,
  );

  // Correct checksum over content that is not a keystore envelope.
  const notKeystore = JSON.stringify({ hello: 'world' });
  const envelope = {
    v: BACKUP_VERSION,
    app: BACKUP_APP,
    account: 'a@b.c',
    savedAt: '2026-01-01T00:00:00.000Z',
    sha256: await sha256Hex(notKeystore),
    keystore: notKeystore,
  };
  await assert.rejects(() => parseBackup(JSON.stringify(envelope), { email: 'a@b.c' }), /unreadable/i);

  const emptyWallets = JSON.stringify({ v: 1, wallets: [] });
  const emptyEnvelope = { ...envelope, keystore: emptyWallets, sha256: await sha256Hex(emptyWallets) };
  await assert.rejects(() => parseBackup(JSON.stringify(emptyEnvelope), { email: 'a@b.c' }), /unreadable/i);
});

// Regression: reauthenticateWithPopup() takes the signed-in user, and passing
// the Auth instance instead throws "Cannot read properties of undefined
// (reading 'app')" from inside Firebase, which is what users saw.
test('Drive access re-authenticates the user, not the Auth instance', async () => {
  const source = await readFile(new URL('../lib/driveBackup.js', import.meta.url), 'utf8');
  assert.match(source, /reauthenticateWithPopup\(user, provider\)/);
  assert.doesNotMatch(source, /reauthenticateWithPopup\(auth,/);
});

// Every failure the user can hit must produce a popup that says what happened
// and, where the user can fix it, the page that fixes it.
test('failures map to a popup with a title and, when fixable, a link', () => {
  const apiOff = describeDriveFailure(Object.assign(new Error('x'), { code: 'DRIVE_API_DISABLED' }));
  assert.match(apiOff.title, /Drive API/i);
  assert.match(apiOff.fix.url, /console\.cloud\.google\.com\/apis\/library\/drive\.googleapis\.com/);
  assert.equal(apiOff.tone, 'err');

  const refused = describeDriveFailure(Object.assign(new Error('x'), { code: 'DRIVE_REFUSED' }));
  assert.match(refused.title, /refused/i);
  assert.match(refused.fix.url, /apis\/credentials\/consent/);

  const expired = describeDriveFailure(Object.assign(new Error('x'), { code: 'TOKEN_EXPIRED' }));
  assert.match(expired.message, /again/i);
  assert.equal(expired.fix, undefined);

  const noBackup = describeDriveFailure(Object.assign(new Error('x'), { code: 'NO_BACKUP' }));
  assert.match(noBackup.title, /Nothing to restore/i);
  assert.equal(noBackup.tone, 'warn');

  const mismatch = describeDriveFailure(Object.assign(new Error('belongs to b@c'), { code: 'ACCOUNT_MISMATCH' }));
  assert.match(mismatch.title, /another account/i);
  assert.match(mismatch.message, /belongs to b@c/);

  const unknown = describeDriveFailure(new Error('boom'));
  assert.equal(unknown.tone, 'err');
  assert.match(unknown.message, /boom/);

  // Raw Firebase text must never reach the screen unreworded.
  const blocked = describeDriveFailure(new Error('Firebase: Error (auth/popup-blocked).'));
  assert.match(blocked.title, /blocked the Google window/i);
  assert.doesNotMatch(blocked.message, /Firebase:/);

  const closed = describeDriveFailure(Object.assign(new Error('x'), { code: 'auth/popup-closed-by-user' }));
  assert.match(closed.title, /closed/i);
  assert.equal(closed.tone, 'warn');

  // A Drive 403 raised inside the Google popup arrives as a Firebase code.
  const buried = describeDriveFailure(new Error(
    'Firebase: Error (auth/google-drive-api-has-not-been-used-in-project-947843190791-before-or-it-is-disabled.).',
  ));
  assert.match(buried.title, /Drive API/i);
  assert.match(buried.fix.url, /drive\.googleapis\.com/);
});

function driveStub(files) {
  const calls = [];
  const doFetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body });
    if (url.includes('uploadType=multipart')) {
      return { ok: true, status: 200, json: async () => ({ id: 'new-file', modifiedTime: '2026-05-05T00:00:00.000Z' }) };
    }
    if (url.includes('uploadType=media')) {
      return { ok: true, status: 200, json: async () => ({ id: 'abc', modifiedTime: '2026-05-06T00:00:00.000Z' }) };
    }
    if (url.includes('/files?')) {
      return { ok: true, status: 200, json: async () => ({ files }) };
    }
    return { ok: true, status: 200, text: async () => '{"v":1}' };
  };
  return { doFetch, calls };
}

test('the first backup creates a file in the app-private folder', async () => {
  const { doFetch, calls } = driveStub([]);
  const result = await uploadBackup('token-1', '{"v":1}', { doFetch });
  assert.equal(result.existed, false);
  assert.equal(result.modifiedTime, '2026-05-05T00:00:00.000Z');

  const create = calls.find((c) => c.method === 'POST');
  assert.ok(create, 'expected a create call');
  assert.match(create.url, /uploadType=multipart$/);
  assert.equal(create.headers.Authorization, 'Bearer token-1');
  assert.match(create.body, /"parents":\["appDataFolder"\]/);
  assert.match(create.body, new RegExp(BACKUP_FILENAME.replace('.', '\\.')));
  assert.match(calls[0].url, /spaces=appDataFolder/);
});

test('a later backup overwrites the same file instead of adding another', async () => {
  const { doFetch, calls } = driveStub([{ id: 'abc', modifiedTime: '2026-05-01T00:00:00.000Z' }]);
  const result = await uploadBackup('token-2', '{"v":1}', { doFetch });
  assert.equal(result.existed, true);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.ok(patch);
  assert.match(patch.url, /\/files\/abc\?uploadType=media$/);
  assert.equal(patch.body, '{"v":1}');
});

test('download returns null when the account has no backup yet', async () => {
  const { doFetch, calls } = driveStub([]);
  assert.equal(await downloadBackup('token-3', { doFetch }), null);
  assert.equal(calls.length, 1);
});

test('download reads the file content through alt=media', async () => {
  const { doFetch, calls } = driveStub([{ id: 'abc', modifiedTime: '2026-05-01T00:00:00.000Z' }]);
  const found = await downloadBackup('token-4', { doFetch });
  assert.equal(found.text, '{"v":1}');
  const media = calls.find((c) => c.url.includes('alt=media'));
  assert.ok(media);
  assert.equal(media.headers.Authorization, 'Bearer token-4');
});
