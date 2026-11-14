// Build the NSAT Wallet browser extension (Chrome MV3) into extension/dist.
//
// The extension is a thin distribution shell over the web wallet's audited
// stack: components/WalletPanel.js and lib/* are bundled VERBATIM — the same
// UI, codec, keystore, preflight gate, and gateway client the
// satoshicore.org wallet page serves. Only two things differ from the web
// deployment, both injected at build time:
//   1. storage backend  — extension/src/storage.js (chrome.storage.local)
//   2. configuration    — the define map below (gateway/indexer/network id)
//
// Usage:
//   npm run build:extension
//   NSAT_EXT_GATEWAY_URL=https://gw.example  NSAT_EXT_INDEXER_URL=... \
//     npm run build:extension            # production endpoints
//
// Defaults are the public DOMAIN endpoints — gateway.satoshicore.org and
// satoshicore.org — never a bare IP, so a plain `npm run build:extension`
// ships something that keeps working after the machine/host changes. A
// devnet build must opt in explicitly:
//   NSAT_EXT_GATEWAY_URL=http://127.0.0.1:8787 NSAT_EXT_INDEXER_URL=http://127.0.0.1:8789
// host_permissions are derived from the same values, so the popup's fetches
// are exempt from CORS for exactly the configured wallet backends and nothing
// else.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, 'extension');

// One shared application, one adapter per browser family. The JS bundle is
// identical (the popup only uses chrome.* APIs that Firefox exposes as
// browser.*/chrome.* alike); only the manifest differs. Target output:
//   chromium → extension/dist          (Chrome, Edge, Brave, Opera, Vivaldi)
//   firefox  → extension/dist-firefox
const TARGET = (process.env.NSAT_EXT_TARGET || 'chromium').toLowerCase();
if (!['chromium', 'firefox'].includes(TARGET)) {
  throw new Error(`unknown NSAT_EXT_TARGET "${TARGET}" (expected chromium or firefox)`);
}
const dist = join(src, TARGET === 'firefox' ? 'dist-firefox' : 'dist');

const GATEWAY = (process.env.NSAT_EXT_GATEWAY_URL || 'https://gateway.satoshicore.org').replace(/\/+$/, '');
const INDEXER = (process.env.NSAT_EXT_INDEXER_URL || 'https://satoshicore.org').replace(/\/+$/, '');

// An IP or loopback origin is a development convenience, never a release
// artifact: refuse to bake one in unless the caller asks for a devnet build.
const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i;
if ((LOOPBACK.test(GATEWAY) || LOOPBACK.test(INDEXER)) && process.env.NSAT_EXT_ALLOW_LOOPBACK !== '1') {
  throw new Error(
    `refusing to bake a loopback endpoint into the extension (gateway ${GATEWAY}, indexer ${INDEXER}).\n`
    + 'Use the public domains, or set NSAT_EXT_ALLOW_LOOPBACK=1 for a local devnet build.',
  );
}
// The network passphrase is the signing identity — the exact Mainnet
// constant by default, overridable only for a devnet build. nsatClient
// refuses to sign when the node's reported identity differs (fail-closed).
const NETWORK_ID = process.env.NSAT_EXT_NETWORK_ID
  || 'NSAT Mainnet ; October 2026 ; bc3098829fffc717';
// Match the web wallet's default so the popup does not keep signing power
// longer than the page does; the panel itself clamps 1–60 min.
const IDLE_LOCK_MS = process.env.NSAT_EXT_IDLE_LOCK_MS || String(5 * 60_000);
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const define = {
  'process.env.NODE_ENV': '"production"',
  'process.env.NEXT_PUBLIC_API_SAME_ORIGIN': '"0"',
  'process.env.NEXT_PUBLIC_API_GATEWAY_URL': JSON.stringify(GATEWAY),
  'process.env.NEXT_PUBLIC_INDEXER_URL': JSON.stringify(INDEXER),
  'process.env.NEXT_PUBLIC_NSAT_NETWORK_ID': JSON.stringify(NETWORK_ID),
  'process.env.NEXT_PUBLIC_IDLE_LOCK_MS': JSON.stringify(IDLE_LOCK_MS),
};

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(src, 'src', 'popup.jsx')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome114',
  jsx: 'automatic',
  // WalletPanel.js / PageHeader.js contain JSX in .js files.
  loader: { '.js': 'jsx', '.jsx': 'jsx' },
  minify: true,
  sourcemap: false,
  outfile: join(dist, 'popup.js'),
  define,
  logLevel: 'info',
  legalComments: 'none',
});

copyFileSync(join(src, 'popup.html'), join(dist, 'popup.html'));
copyFileSync(join(root, 'app', 'wallet', 'wallet.css'), join(dist, 'wallet.css'));
mkdirSync(join(dist, 'icons'), { recursive: true });
for (const size of [16, 48, 128]) {
  copyFileSync(join(src, 'icons', `icon-${size}.png`), join(dist, `icons`, `icon-${size}.png`));
}

const manifest = {
  manifest_version: 3,
  name: 'NSAT Wallet',
  short_name: 'NSAT',
  description:
    'NSAT wallet for SatoshiCore. Keys are generated and encrypted on this device; '
    + 'transactions are signed locally and relayed unsigned-keyless through the gateway.',
  version: pkg.version,
  action: {
    default_title: 'NSAT Wallet',
    default_popup: 'popup.html',
    default_icon: { 16: 'icons/icon-16.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
  },
  icons: { 16: 'icons/icon-16.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
  permissions: ['storage', 'downloads'],
  host_permissions: [`${GATEWAY}/*`, `${INDEXER}/*`],
};

if (TARGET === 'firefox') {
  // Firefox ignores minimum_chrome_version and needs a stable add-on ID for
  // an unpacked MV3 install plus a minimum version that supports MV3 action
  // popups. Firefox exposes the same storage/downloads APIs to an extension
  // page, so the bundle is shared unchanged.
  manifest.browser_specific_settings = {
    gecko: { id: 'wallet@satoshicore.org', strict_min_version: '121.0' },
  };
} else {
  manifest.minimum_chrome_version = '114';
}

writeFileSync(join(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`extension built (${TARGET}) → ${dist}`);
console.log(`  gateway:  ${GATEWAY}`);
console.log(`  indexer:  ${INDEXER}`);
console.log(`  network:  ${NETWORK_ID}`);
