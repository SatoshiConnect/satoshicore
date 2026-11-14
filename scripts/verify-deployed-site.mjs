#!/usr/bin/env node
// Post-deploy verification for the static export.
//
// Run this against the URL that will actually serve users — after a deploy, or
// before one to prove what is currently live:
//
//   node scripts/verify-deployed-site.mjs https://satoshicore.org
//   node scripts/verify-deployed-site.mjs ${{ steps.deployment.outputs.page_url }}
//
// It only reads. It stores nothing, signs nothing and never contacts the
// gateway with a transaction. Exit code 1 means at least one check failed, so
// CI fails instead of reporting a deploy as successful when the artifact is
// not actually being served (an old build, a cached HTML shell, a 404 on PWA
// assets, or HTML served with the wrong content type).
//
// No dependencies: Node 20+ has global fetch.

import { readFileSync } from 'node:fs';

const SITE_TIMEOUT_MS = 15_000;

const args = process.argv.slice(2).filter((a) => a !== '--');
const rawBase = args[0];
if (!rawBase || !/^https?:\/\//.test(rawBase)) {
  console.error('usage: node scripts/verify-deployed-site.mjs <https://site-origin[/basepath]>');
  process.exit(2);
}

const base = new URL(rawBase.endsWith('/') ? rawBase : `${rawBase}/`);
const basePath = base.pathname.replace(/\/$/, ''); // '' at a domain root, '/repo' on github.io

function url(path) {
  return new URL(path.replace(/^\//, ''), base).toString();
}

async function get(path, init = {}) {
  const res = await fetch(url(path), {
    redirect: 'follow',
    signal: AbortSignal.timeout(SITE_TIMEOUT_MS),
    ...init
  });
  const body = await res.text();
  return { res, body, status: res.status, type: res.headers.get('content-type') || '' };
}

function isHtml(type) {
  return /text\/html/i.test(type);
}

const results = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
  }
}

async function advisory(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, advisory: true, detail });
  } catch (err) {
    // Advisory checks describe services the site depends on but does not own
    // (the gateway origin allowlist, for example). They are reported, never
    // gated: a deploy cannot fail because someone else's allowlist is stale.
    results.push({ name, ok: false, advisory: true, detail: err.message });
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function page(path) {
  return async () => {
    const { status, type, body } = await get(path);
    assert(status === 200, `${path} returned HTTP ${status}`);
    assert(isHtml(type), `${path} served ${type || 'no content-type'} instead of HTML`);
    return `${path} 200, ${body.length} bytes`;
  };
}

function contains(path, needles) {
  return async () => {
    const { status, type, body } = await get(path);
    assert(status === 200, `${path} returned HTTP ${status}`);
    assert(isHtml(type), `${path} served ${type || 'no content-type'} instead of HTML`);
    for (const needle of needles) {
      assert(body.includes(needle), `${path} is missing "${needle}" — the deployed build is not this build`);
    }
    return `${path} carries ${needles.length} expected markers`;
  };
}

async function main() {
  console.log(`Verifying ${base.href}\n`);

  // --- The site itself -----------------------------------------------------
  await check('Homepage is the wallet itself, not a landing page', async () => {
    const { status, type, body } = await get('/');
    assert(status === 200, `GET / returned HTTP ${status}`);
    assert(isHtml(type), `GET / served ${type || 'no content-type'} instead of HTML`);
    assert(body.includes('nw-root'), 'homepage does not render the wallet shell');
    assert(body.includes('Create a New Wallet'), 'homepage has no create-wallet action');
    assert(body.includes('Import Existing Wallet'), 'homepage has no import action');
    assert(/href="[^"]*\/download\/?"/.test(body), 'homepage has no extension download action');
    assert(!body.includes('Open NSAT Wallet'), 'the old landing CTA is still being served');
    return 'wallet-first homepage served';
  });

  await check('Wallet page renders', page('/wallet/'));
  await check('Docs page renders', page('/docs/'));

  await check('Download page states the real artifact', async () => {
    const { status, type, body } = await get('/download/');
    assert(status === 200, `/download/ returned HTTP ${status}`);
    assert(isHtml(type), `/download/ served ${type || 'no content-type'} instead of HTML`);
    assert(/[a-f0-9]{64}/.test(body), 'download page has no sha256 digest');
    assert(/not published/i.test(body), 'download page does not say the artifact is unpublished');
    return 'sha256 + unpublished status present';
  });

  // The page used to print the filename without serving the file, so the
  // obvious click (and /extension/<file>.zip) was a 404.
  await check('Extension downloads are actually served', async () => {
    const release = JSON.parse(
      readFileSync(new URL('../extension/release.json', import.meta.url), 'utf8'),
    );
    const artifacts = [
      [release.file, release.bytes],
      [release.firefoxFile, release.firefoxBytes],
    ];
    for (const [name, bytes] of artifacts) {
      const res = await fetch(url(`/extension/${name}`), {
        signal: AbortSignal.timeout(SITE_TIMEOUT_MS),
      });
      assert(res.status === 200, `/extension/${name} returned HTTP ${res.status}`);
      const served = Number(res.headers.get('content-length'));
      assert(
        !Number.isNaN(served) && served === bytes,
        `/extension/${name} is ${res.headers.get('content-length')} bytes, release.json says ${bytes}`,
      );
      void res.body?.cancel();
    }
    return `${artifacts.length} artifacts downloadable`;
  });

  // --- PWA: manifest, service worker, shell --------------------------------
  await check('Web app manifest is deployed and installable', async () => {
    const { status, type, body } = await get('/manifest.json');
    assert(status === 200, `manifest returned HTTP ${status} — this build has no PWA manifest deployed`);
    // Hosts vary between application/manifest+json and octet-stream for this
    // extension; the parsed contents below are what actually matters.
    assert(/json/i.test(type), `manifest served as ${type || 'no content-type'}; it must be a JSON MIME type`);
    const manifest = JSON.parse(body);
    assert(manifest.display === 'standalone', `display is ${manifest.display}, expected standalone`);
    assert(manifest.name && manifest.short_name, 'manifest needs name and short_name');
    assert(manifest.start_url && !manifest.start_url.startsWith('/'), `start_url "${manifest.start_url}" is absolute and breaks the base path`);
    assert(manifest.start_url === './', `start_url is "${manifest.start_url}", expected the wallet homepage`);
    const sizes = new Set((manifest.icons || []).map((i) => i.sizes));
    assert(sizes.has('192x192') && sizes.has('512x512'), 'manifest needs 192x192 and 512x512 icons');
    return `${manifest.icons.length} icons, start_url ${manifest.start_url}`;
  });

  await check('Manifest icons are served as PNG', async () => {
    const { body: manifestBody } = await get('/manifest.json');
    const manifest = JSON.parse(manifestBody);
    for (const icon of manifest.icons || []) {
      const res = await fetch(url(icon.src), { signal: AbortSignal.timeout(SITE_TIMEOUT_MS) });
      const type = res.headers.get('content-type') || '';
      assert(res.status === 200, `${icon.src} returned HTTP ${res.status}`);
      assert(/image\/png|image\/svg\+xml/i.test(type), `${icon.src} served as ${type}`);
    }
    return `${manifest.icons.length} icon files fetched`;
  });

  await check('Offline shell service worker ships and is scoped to this origin', async () => {
    const { status, type, body } = await get('/sw.js');
    assert(status === 200, `sw.js returned HTTP ${status}`);
    assert(/javascript/i.test(type), `sw.js served as ${type || 'no content-type'}`);
    assert(body.includes("url.origin !== self.location.origin"), 'worker does not ignore cross-origin requests');
    assert(body.includes("request.method !== 'GET'"), 'worker intercepts non-GET requests');
    assert(!/(gateway|api)\.satoshicore\.org/.test(body), 'worker names a money endpoint');
    return 'offline-only, same-origin, GET-only';
  });

  await check('Offline page explains the network requirement', async () => {
    const { status, body } = await get('/offline.html');
    assert(status === 200, `offline.html returned HTTP ${status}`);
    assert(/offline/i.test(body), 'offline page does not mention being offline');
    return 'offline.html present';
  });

  // --- Services the site depends on (advisory) -----------------------------
  const origin = base.origin;
  const gateway = process.env.VERIFY_GATEWAY_URL || 'https://gateway.satoshicore.org';

  await advisory(`Gateway answers /health at ${gateway}`, async () => {
    const res = await fetch(`${gateway}/health`, { signal: AbortSignal.timeout(SITE_TIMEOUT_MS) });
    assert(res.ok, `HTTP ${res.status}`);
    return `HTTP ${res.status}`;
  });

  await advisory(`Gateway CORS allows the deployed origin ${origin}`, async () => {
    const res = await fetch(`${gateway}/api/v1/chain/info`, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'content-type'
      },
      signal: AbortSignal.timeout(SITE_TIMEOUT_MS)
    });
    const allow = res.headers.get('access-control-allow-origin');
    assert(
      allow === origin || allow === '*',
      `preflight HTTP ${res.status} without Access-Control-Allow-Origin for ${origin} (owner must add it to the gateway allowlist)`
    );
    return `preflight ${res.status}, allow-origin ${allow}`;
  });

  // --- Report --------------------------------------------------------------
  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    const label = r.advisory ? (r.ok ? 'WARN' : 'WARN') : r.ok ? 'PASS' : 'FAIL';
    console.log(`${label}  ${r.name.padEnd(width)}  ${r.detail}`);
  }

  const failures = results.filter((r) => !r.ok && !r.advisory);
  const warnings = results.filter((r) => r.advisory);
  console.log(
    `\n${results.length - failures.length - warnings.length} passed, ${failures.length} failed, ` +
      `${warnings.length} advisory (base path "${basePath || '/'}")`
  );

  if (failures.length > 0) {
    console.log('\nThe deployed site does not match this build. Do not announce it as deployed.');
    process.exit(1);
  }
  if (warnings.length > 0) {
    console.log('\nAdvisory items need owner action; they do not block the site itself.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
