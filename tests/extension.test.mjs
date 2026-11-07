// Browser-extension wallet tests.
// Run against extension/dist after `npm run build:extension`:
//   npm run test:extension
//
// Covers the extension-specific acceptance surface (the wallet engine itself
// is covered by tests/keystore.test.mjs + tests/send-preflight.test.mjs):
//   - MV3 manifest validity + minimal permission set
//   - popup.html satisfies the MV3 extension-pages CSP (no inline script,
//     no inline event handlers — script-src 'self' with bundled code only)
//   - build-time config injection (exact network passphrase, no same-origin
//     mode) is present in the bundle
//   - the chrome.storage adapter round-trips the REAL keystore code path
//     (create → persist → rehydrate → unlock) against a fake storage area
//   - no secrets in extension sources or build output
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DIST = join(ROOT, 'extension', 'dist');

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]
  );
}

// ---------------- manifest + popup.html + bundle ----------------

test('extension build output exists', () => {
  assert.ok(statSync(DIST).isDirectory(), 'extension/dist missing — run npm run build:extension');
  for (const f of ['manifest.json', 'popup.html', 'popup.js', 'wallet.css',
    'icons/icon-16.png', 'icons/icon-48.png', 'icons/icon-128.png']) {
    assert.ok(existsSync(join(DIST, f)), `missing build artifact: ${f}`);
  }
});

test('manifest is valid MV3 with the minimal permission set', () => {
  const m = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'));
  assert.equal(m.manifest_version, 3);
  assert.equal(m.action?.default_popup, 'popup.html');
  // Exactly the grants the popup needs — no tabs, no content scripts, no
  // <all_urls>: the wallet talks only to the configured backend origins.
  assert.deepEqual([...m.permissions].sort(), ['downloads', 'storage']);
  assert.ok(m.host_permissions.length >= 1, 'host_permissions must name the wallet backends');
  for (const h of m.host_permissions) {
    assert.match(h, /^https?:\/\/[^/]+\/\*$/, `malformed host permission: ${h}`);
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(m.version, pkg.version, 'manifest version must track package.json');
});

test('popup.html is CSP-safe for MV3 (script-src self, no remote code)', () => {
  const html = readFileSync(join(DIST, 'popup.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)].map((mm) => mm[1]);
  assert.ok(scripts.length >= 1, 'popup must reference popup.js');
  for (const attrs of scripts) {
    assert.match(attrs, /\bsrc=/, 'inline <script> blocks are forbidden under MV3 CSP');
    assert.doesNotMatch(attrs, /https?:\/\//, 'remote script origins are forbidden');
  }
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'inline event handlers are forbidden');
  assert.ok(html.includes('wallet.css'), 'popup must load the wallet stylesheet');
  assert.ok(html.includes('id="root"'), 'popup must mount the React root');
});

test('bundle carries the build-time identity, not a runtime-configurable one', () => {
  const js = readFileSync(join(DIST, 'popup.js'), 'utf8');
  // The exact Mainnet passphrase must be baked in (fail-closed identity gate).
  assert.ok(js.includes('NSAT Mainnet ; October 2026 ; bc3098829fffc717'),
    'network passphrase missing from bundle');
  assert.ok(js.includes('scw-web-keystore-v1'), 'keystore key missing from bundle');
  assert.doesNotMatch(js, /\beval\s*\(/, 'eval() is forbidden in the bundle');
  assert.doesNotMatch(js, /new\s+Function\s*\(/, 'new Function() is forbidden in the bundle');
});

test('no secrets in extension sources or build output', () => {
  const S_RE = /\bS[A-Z2-7]{55}\b/;
  for (const f of [...walk(join(ROOT, 'extension')), ...walk(join(ROOT, 'scripts'))]) {
    if (/\.(png)$/.test(f)) continue;
    assert.ok(!S_RE.test(readFileSync(f, 'utf8')), `S… seed strkey found in ${f}`);
  }
});

// ---------------- chrome.storage adapter × real keystore ----------------

// Minimal chrome.storage.StorageArea fake: async get(null)/set(obj).
function fakeArea() {
  const data = new Map();
  return {
    data,
    async get(_k) { return Object.fromEntries(data); },
    async set(obj) { for (const [k, v] of Object.entries(obj)) data.set(k, v); },
  };
}

const { createWalletStorage } = await import('../extension/src/storage.js');
const { setWalletStorage, keystoreCreate, keystoreList, keystoreUnlock, keystoreExport } =
  await import('../lib/nsatWallet.js');

test('adapter hydrates only scw-web-* string keys and ignores everything else', async () => {
  const area = fakeArea();
  area.data.set('scw-web-keystore-v1', '{"v":1,"wallets":[]}');
  area.data.set('scw-web-history-alice', '[]');
  area.data.set('unrelated-pref', 'x');
  area.data.set('scw-web-not-a-string', { nope: 1 });
  const s = createWalletStorage(area);
  await s.hydrate();
  assert.equal(s.getItem('scw-web-keystore-v1'), '{"v":1,"wallets":[]}');
  assert.equal(s.getItem('scw-web-history-alice'), '[]');
  assert.equal(s.getItem('unrelated-pref'), null, 'non-wallet keys must not hydrate');
  assert.equal(s.getItem('scw-web-not-a-string'), null, 'non-string values must not hydrate');
  assert.equal(s.getItem('scw-web-missing'), null);
});

test('keystore create → persist → rehydrate → unlock works end-to-end off chrome.storage', async () => {
  // The full custody path the popup uses: nsatWallet's audited code writing
  // AES-GCM ciphertext through the adapter into chrome.storage.local.
  const area = fakeArea();
  const first = createWalletStorage(area);
  await first.hydrate();
  setWalletStorage(first);

  const { pubkeyG } = await keystoreCreate('ext-a', 'pw-ext-a');
  assert.match(pubkeyG, /^G[A-Z2-7]{55}$/);
  // Ciphertext (not the seed) is what reached the storage area.
  assert.ok(area.data.has('scw-web-keystore-v1'), 'keystore blob never persisted');
  const blob = keystoreExport();
  assert.ok(!blob.includes('seedS'), 'plaintext seed must never persist');
  assert.deepEqual(keystoreList(), [{ name: 'ext-a', pubkey: pubkeyG }]);

  // Simulate popup close/reopen: a FRESH adapter over the same persisted area.
  const second = createWalletStorage(area);
  await second.hydrate();
  setWalletStorage(second);
  assert.deepEqual(keystoreList(), [{ name: 'ext-a', pubkey: pubkeyG }],
    'rehydrated popup must see the persisted wallet');
  const seed = await keystoreUnlock('ext-a', 'pw-ext-a');
  assert.ok(seed instanceof Uint8Array && seed.length === 32);
  await assert.rejects(() => keystoreUnlock('ext-a', 'wrong'), /wrong password/);
});

test('setItem mirrors writes to the storage area asynchronously', async () => {
  const area = fakeArea();
  const s = createWalletStorage(area);
  await s.hydrate();
  s.setItem('scw-web-history-x', '[{"txhash":"ab"}]');
  assert.equal(s.getItem('scw-web-history-x'), '[{"txhash":"ab"}]');
  await new Promise((r) => setTimeout(r, 0)); // flush the persist promise
  assert.equal(area.data.get('scw-web-history-x'), '[{"txhash":"ab"}]',
    'write-through to chrome.storage did not land');
});
