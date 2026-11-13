// Static-export verification tests. Run against ./out after `next build`.
// These assert the constraints required for a GitHub Pages deployment:
// plain static files, correct asset paths, and no server-only artifacts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const OUT = process.argv[2] || join(process.cwd(), 'out');

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]
  );
}

const files = walk(OUT);

test('static export exists', () => {
  assert.ok(statSync(OUT).isDirectory(), 'out/ directory missing');
  assert.ok(existsSync(join(OUT, 'index.html')), 'index.html missing');
});

test('no Node.js server artifacts in output', () => {
  const forbidden = ['.env', '.pem', '.key', 'server.js', '.node'];
  for (const f of files) {
    for (const suffix of forbidden) {
      assert.ok(!f.endsWith(suffix), `forbidden artifact in output: ${f}`);
    }
  }
});

test('all required public pages rendered as HTML', () => {
  for (const page of ['index.html', 'wallet/index.html', 'docs/index.html', 'status/index.html']) {
    assert.ok(existsSync(join(OUT, page)), `missing static page: ${page}`);
  }
});

test('HTML references assets with consistent base path', () => {
  const indexPath = join(OUT, 'index.html');
  const html = readFileSync(indexPath, 'utf8');
  const scriptSrcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(scriptSrcs.length > 0, 'no scripts found in index.html');

  // Detect the base path actually used by the build (e.g. /satoshicore for
  // github.io preview builds, empty for custom-domain builds) so the test
  // works for both without depending on build-time env.
  const firstLocal = scriptSrcs.find((s) => !/^https?:/.test(s));
  const basePath = firstLocal.match(/^([^"]*?)\/_next\//)?.[1] || '';

  for (const src of scriptSrcs) {
    if (/^https?:/.test(src)) continue; // external CDN allowed
    assert.ok(
      src.startsWith(`${basePath}/_next/`),
      `asset path ${src} is inconsistent with detected base path "${basePath}"`
    );
  }

  // Every referenced local script must actually exist in the output.
  for (const src of scriptSrcs) {
    if (/^https?:/.test(src)) continue;
    const rel = src.startsWith('/') ? src.slice(basePath.length + 1) : src;
    assert.ok(existsSync(join(OUT, rel)), `referenced asset missing from output: ${src}`);
  }
});

test('no obvious secrets or key material in output', () => {
  const secretPatterns = [
    /ghp_[A-Za-z0-9]{36}/,
    /github_pat_[A-Za-z0-9_]{20,}/,
    /AKIA[0-9A-Z]{16}/,
    /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/
  ];
  for (const f of files) {
    if (!/\.(html|js|css|json|txt|xml|svg)$/.test(f)) continue;
    const content = readFileSync(f, 'utf8');
    for (const re of secretPatterns) {
      assert.ok(!re.test(content), `potential secret matched in ${relative(process.cwd(), f)}`);
    }
  }
});

// ----------------------------- PWA assets --------------------------------
// The wallet is installable from the static export: a manifest, an offline
// shell service worker and icons must ship as plain files next to the pages.

test('PWA manifest is present, installable and subpath-safe', () => {
  const manifestPath = join(OUT, 'manifest.webmanifest');
  assert.ok(existsSync(manifestPath), 'manifest.webmanifest missing from export');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.name && manifest.short_name, 'name/short_name required for install');
  assert.equal(manifest.start_url, './wallet/', 'start_url must open the wallet and stay relative');
  assert.equal(manifest.scope, './', 'scope must stay relative for subpath hosting');
  assert.ok(!manifest.start_url.startsWith('/'), 'absolute start_url breaks the base path');

  const sizes = new Set(manifest.icons.map((i) => i.sizes));
  assert.ok(sizes.has('192x192') && sizes.has('512x512'), '192 and 512 icons required');
  for (const icon of manifest.icons) {
    assert.ok(existsSync(join(OUT, icon.src)), `icon missing from export: ${icon.src}`);
  }
});

test('offline shell service worker ships and never caches other origins', () => {
  const swPath = join(OUT, 'sw.js');
  assert.ok(existsSync(swPath), 'sw.js missing from export');
  const sw = readFileSync(swPath, 'utf8');

  assert.ok(existsSync(join(OUT, 'offline.html')), 'offline.html missing from export');
  assert.match(sw, /url\.origin !== self\.location\.origin/, 'cross-origin requests must be ignored');
  assert.match(sw, /request\.method !== 'GET'/, 'non-GET requests must never be intercepted');
  assert.doesNotMatch(sw, /gateway\.satoshicore\.org|satoshicore\.org\/v1/, 'worker must not name a money endpoint');
});

test('offline shell precache list resolves inside the export', () => {
  const sw = readFileSync(join(OUT, 'sw.js'), 'utf8');
  const list = sw.match(/const SHELL = \[([\s\S]*?)\];/)?.[1];
  assert.ok(list, 'service worker has no SHELL list');

  const paths = [...list.matchAll(/'([^']*)'/g)].map((m) => m[1]);
  assert.ok(paths.length >= 5, `SHELL list looks incomplete (${paths.length} entries)`);

  for (const p of paths) {
    // The install handler resolves each entry against the registration scope,
    // so every entry must be relative and must exist in the export — otherwise
    // the offline shell promises a page it cannot show.
    assert.ok(!/^(https?:)?\/\//.test(p) && !p.startsWith('/'), `SHELL entry "${p}" is not relative to the scope`);
    const rel = p === '' ? 'index.html' : p.endsWith('/') ? `${p}index.html` : p;
    assert.ok(existsSync(join(OUT, rel)), `SHELL precaches ${p} but ${rel} is not in the export`);
  }
  assert.ok(paths.includes('wallet/'), 'the wallet itself must be part of the offline shell');
  assert.ok(paths.includes('offline.html'), 'offline.html must be part of the offline shell');
});

test('homepage is wallet-first and download page exists', () => {
  const home = readFileSync(join(OUT, 'index.html'), 'utf8');
  assert.match(home, /Open NSAT Wallet/, 'homepage must offer the wallet as the primary action');
  assert.match(home, /Install Browser Extension/, 'homepage must offer the extension action');
  assert.match(home, /href="\/wallet\/"/, 'wallet action must link to /wallet/');

  assert.ok(existsSync(join(OUT, 'download/index.html')), 'download page missing from export');
  assert.ok(existsSync(join(OUT, 'wallet/index.html')), 'wallet page missing from export');
});
