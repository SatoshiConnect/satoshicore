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
