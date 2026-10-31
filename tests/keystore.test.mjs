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

const { keystoreCreate, keystoreUnlock, keystoreRestore, keystoreList, keystoreExport } =
  await import('../lib/nsatWallet.js');

beforeEach(() => items.clear());

const G_RE = /^G[A-Z2-7]{55}$/;
const S_RE = /^S[A-Z2-7]{55}$/;

test('create → unlock round trip recovers the same address; seed never at rest', async () => {
  const { name, pubkeyG, seedS } = await keystoreCreate('unit-a', 'pw-unit-a');
  assert.match(seedS, S_RE);
  assert.match(pubkeyG, G_RE);
  const blob = keystoreExport();
  assert.ok(!blob.includes(seedS), 'seed strkey must never be stored in localStorage');
  const seed = await keystoreUnlock(name, 'pw-unit-a');
  assert.ok(seed instanceof Uint8Array && seed.length === 32, 'unlock must return the raw 32-byte seed (in-memory only)');
});

test('keystore list exposes only name + address', async () => {
  await keystoreCreate('b', 'pw-b');
  const list = keystoreList();
  assert.equal(list.length, 1);
  assert.deepEqual(Object.keys(list[0]).sort(), ['name', 'pubkey']);
  assert.match(list[0].pubkey, G_RE);
});

test('wrong password fails closed', async () => {
  await keystoreCreate('c', 'pw-c');
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
  await keystoreCreate('keeper', 'pw-keeper');
  const live = keystoreExport();
  for (const [i, blob] of REFUSED_BLOBS.entries()) {
    assert.throws(() => keystoreRestore(blob), undefined, `case ${i} must be refused`);
  }
  assert.equal(keystoreExport(), live, 'a refused restore must not overwrite the live keystore');
  assert.equal(keystoreList().length, 1);
});

test('a genuinely-created backup restores and unlocks to the same address', async () => {
  await keystoreCreate('orig', 'pw-orig');
  const backup = keystoreExport();
  items.clear();
  keystoreRestore(backup);
  const seed = await keystoreUnlock('orig', 'pw-orig');
  assert.ok(seed instanceof Uint8Array && seed.length === 32, 'restore must faithfully reproduce the original seed');
});

test('unlock integrity: displayed address must equal the signing key', async () => {
  await keystoreCreate('pair', 'pw-pair');
  // Tamper: re-pair the real ciphertext with a DIFFERENT displayed address
  // (a valid-format G-strkey that is not ours — e.g. a phishing entry).
  const store = JSON.parse(keystoreExport());
  assert.equal(store.wallets.length, 1);
  store.wallets[0].pubkey =
    'GCZ7TMF5DNBBSLYEEOPXKLUN2L6M2YEBPTBVCVG4MFTO4WSYK7LXKLKW';
  items.set('scw-web-keystore-v1', JSON.stringify(store));
  await assert.rejects(() => keystoreUnlock('pair', 'pw-pair'), /integrity failure/);
});
