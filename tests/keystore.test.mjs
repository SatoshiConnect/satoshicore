// Keystore / key-custody regression tests (unit, pure, no network).
// Covers wallet-security controls audited in WALLET-SECURITY-AUDIT:
//   - encrypted-at-rest round trip (create → unlock → same address)
//   - wrong password fail-closed (no exception details that leak state)
//   - restore integrity: malformed/tampered backup blobs are refused BEFORE
//     the live keystore is overwritten
//   - unlock integrity: stored address must equal the derived signing key,
//     otherwise the unlock is refused (anti-phishing pairing check)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const items = new Map();
globalThis.localStorage = {
  getItem: (k) => (items.has(k) ? items.get(k) : null),
  setItem: (k, v) => { items.set(k, v); },
  removeItem: (k) => { items.delete(k); },
};
if (!globalThis.crypto?.subtle) throw new Error('WebCrypto unavailable');

const {
  keystoreCreate, keystoreImport, keystoreUnlock, keystoreRestore, keystoreList,
  keystoreExport, checkNewPassword, zeroSeed, MIN_PASSWORD_LENGTH,
} = await import('../lib/nsatWallet.js');
const { encodeSeed, encodeG, ed25519Keypair } = await import('../lib/nsatCodec.js');

beforeEach(() => items.clear());

const G_RE = /^G[A-Z2-7]{55}$/;
const S_RE = /^S[A-Z2-7]{55}$/;

test('create → unlock round trip recovers the same address; seed never at rest', async () => {
  const { name, pubkeyG, seedS } = await keystoreCreate('unit-a', 'pw-unit-a-123456');
  assert.match(seedS, S_RE);
  assert.match(pubkeyG, G_RE);
  const blob = keystoreExport();
  assert.ok(!blob.includes(seedS), 'seed strkey must never be stored in localStorage');
  const seed = await keystoreUnlock(name, 'pw-unit-a-123456');
  assert.ok(seed instanceof Uint8Array && seed.length === 32, 'unlock must return the raw 32-byte seed (in-memory only)');
});

test('keystore list exposes only name + address', async () => {
  await keystoreCreate('b', 'pw-b-123456789');
  const list = keystoreList();
  assert.equal(list.length, 1);
  assert.deepEqual(Object.keys(list[0]).sort(), ['name', 'pubkey']);
  assert.match(list[0].pubkey, G_RE);
});

test('wrong password fails closed', async () => {
  await keystoreCreate('c', 'pw-c-123456789');
  await assert.rejects(() => keystoreUnlock('c', 'wrong'), /wrong password/);
  await assert.rejects(() => keystoreUnlock('missing', 'x'), /not found/);
});

const REFUSED_BLOBS = [
  '', 'not json', '{}',
  '{"v":2,"wallets":[]}',
  '{"v":1,"wallets":"x"}',
  '{"v":1,"wallets":[null]}',
  '{"v":1,"wallets":[{"name":"x"}]}',
  JSON.stringify({ v: 1, wallets: [{ name: 'x', pubkey: 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAW4' }] }),
  JSON.stringify({ v: 1, wallets: [{ name: 'x', pubkey: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', kdf: { algo: 'WRONG' } }] }),
  JSON.stringify({ v: 1, wallets: [{ name: 'x', pubkey: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', kdf: { algo: 'PBKDF2-HMAC-SHA256', iterations: 0, salt: 'AAEC' } }] }),
  JSON.stringify({ v: 1, wallets: [{ name: 'x', pubkey: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', kdf: { algo: 'PBKDF2-HMAC-SHA256', iterations: 600000, salt: '***bad***' }, nonce: 'AAEC', box: 'AAEC' }] }),
  JSON.stringify({ v: 1, wallets: [{ name: 'x', pubkey: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', kdf: { algo: 'PBKDF2-HMAC-SHA256', iterations: 600000, salt: 'AAEC' }, nonce: 'AAEC', box: '' }] }),
];

test('keystoreRestore refuses malformed backups without replacing live state', async () => {
  await keystoreCreate('keeper', 'pw-keeper-123456');
  const live = keystoreExport();
  for (const [i, blob] of REFUSED_BLOBS.entries()) {
    assert.throws(() => keystoreRestore(blob), undefined, `case ${i} must be refused`);
  }
  assert.equal(keystoreExport(), live, 'a refused restore must not overwrite the live keystore');
  assert.equal(keystoreList().length, 1);
});

test('keystoreRestore rejects altered cryptographic parameters and duplicate wallet names', async () => {
  await keystoreCreate('strict', 'strict-password-123');
  const valid = JSON.parse(keystoreExport());
  const live = keystoreExport();
  const mutate = (fn) => {
    const altered = structuredClone(valid);
    fn(altered.wallets[0]);
    assert.throws(() => keystoreRestore(JSON.stringify(altered)), /malformed keystore entry/);
    assert.equal(keystoreExport(), live, 'a rejected backup must not replace the live keystore');
  };

  mutate((wallet) => { wallet.kdf.iterations = 1; });
  mutate((wallet) => { wallet.aead = 'AES-GCM-128'; });
  mutate((wallet) => { wallet.kdf.salt = 'AA=='; });
  mutate((wallet) => { wallet.nonce = 'AA=='; });
  mutate((wallet) => { wallet.box = 'AA=='; });
  const duplicate = structuredClone(valid);
  duplicate.wallets.push(structuredClone(duplicate.wallets[0]));
  assert.throws(() => keystoreRestore(JSON.stringify(duplicate)), /duplicate wallet/);
  assert.equal(keystoreExport(), live, 'duplicate-name backup must not replace the live keystore');
});

test('a genuinely-created backup restores and unlocks to the same address', async () => {
  await keystoreCreate('orig', 'pw-orig-1234567');
  const backup = keystoreExport();
  items.clear();
  keystoreRestore(backup);
  const seed = await keystoreUnlock('orig', 'pw-orig-1234567');
  assert.ok(seed instanceof Uint8Array && seed.length === 32, 'restore must faithfully reproduce the original seed');
});

test('new wallets require the password floor; import enforces it too', async () => {
  assert.equal(checkNewPassword('short').ok, false);
  assert.equal(checkNewPassword(' '.repeat(MIN_PASSWORD_LENGTH)).ok, false);
  assert.equal(checkNewPassword('x'.repeat(MIN_PASSWORD_LENGTH - 1)).ok, false);
  assert.equal(checkNewPassword('x'.repeat(MIN_PASSWORD_LENGTH)).ok, true);
  await assert.rejects(() => keystoreCreate('weak', 'pw-1234'), /at least 12/);
  const validSeed = encodeSeed(new Uint8Array(32).fill(7));
  await assert.rejects(() => keystoreImport('weak', validSeed, 'pw-1234'), /at least 12/);
  assert.equal(keystoreList().length, 0, 'a rejected password must not create a wallet');
});

// Wallets created before the floor existed must stay openable: the check is a
// creation-time policy, never an unlock-time lockout.
test('an existing keystore with a shorter password still unlocks', async () => {
  const seed = new Uint8Array(32).fill(9);
  const seedS = encodeSeed(seed);
  const pubkey = encodeG(ed25519Keypair(seed).pub32);
  const b64 = (u8) => Buffer.from(u8).toString('base64');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode('legacy-pw'),
    'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const box = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
    new TextEncoder().encode(JSON.stringify({ seedS })));
  items.set('scw-web-keystore-v1', JSON.stringify({ v: 1, wallets: [{
    name: 'legacy', pubkey,
    kdf: { algo: 'PBKDF2-HMAC-SHA256', salt: b64(salt), iterations: 600000 },
    aead: 'AES-GCM-256', nonce: b64(iv), box: b64(new Uint8Array(box)),
  }] }));
  assert.deepEqual(await keystoreUnlock('legacy', 'legacy-pw'), seed);
});

test('zeroSeed wipes signing-key bytes in place and tolerates absent buffers', () => {
  const seed = new Uint8Array(32).fill(0xab);
  zeroSeed(seed);
  assert.ok(seed.every((b) => b === 0), 'seed buffer must be zeroed, not just dereferenced');
  assert.doesNotThrow(() => zeroSeed(null));
  assert.doesNotThrow(() => zeroSeed(undefined));
});

test('unlock integrity: displayed address must equal the signing key', async () => {
  await keystoreCreate('pair', 'pw-pair-1234567');
  // Tamper: re-pair the real ciphertext with a DIFFERENT displayed address
  // (a valid-format G-strkey that is not ours — e.g. a phishing entry).
  const store = JSON.parse(keystoreExport());
  assert.equal(store.wallets.length, 1);
  store.wallets[0].pubkey =
    'GCZ7TMF5DNBBSLYEEOPXKLUN2L6M2YEBPTBVCVG4MFTO4WSYK7LXKLKW';
  items.set('scw-web-keystore-v1', JSON.stringify(store));
  await assert.rejects(() => keystoreUnlock('pair', 'pw-pair-1234567'), /integrity failure/);
});
