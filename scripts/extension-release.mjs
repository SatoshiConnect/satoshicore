#!/usr/bin/env node
// Keep the published artifact honest.
//
// `extension/release.json` is what /download renders: version, byte size,
// sha256, permissions and endpoints. It was previously edited by hand, so it
// could silently describe a zip that no longer exists or no longer matches the
// file a user is told to load. This script makes that impossible:
//
//   node scripts/extension-release.mjs          # verify (exit 1 on drift)
//   node scripts/extension-release.mjs --write  # recompute from the zips
//
// It also reads the zips and asserts the packaged manifest agrees with
// release.json (version, permissions, target-specific bits), so a stale
// package cannot be advertised as the current build.
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const extDir = join(root, 'extension');
const releasePath = join(extDir, 'release.json');
const write = process.argv.includes('--write');

const release = JSON.parse(readFileSync(releasePath, 'utf8'));
const problems = [];

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

// Minimal ZIP reader: walk the central directory for entry names and pull the
// stored manifest.json out of it. No dependencies, no extraction to disk.
function readZip(file) {
  const buf = readFileSync(file);
  const names = [];
  let manifest = null;
  let idx = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const entries = [];
  while (idx > 0) {
    const nameLen = buf.readUInt16LE(idx + 28);
    const extraLen = buf.readUInt16LE(idx + 30);
    const commentLen = buf.readUInt16LE(idx + 32);
    const compressedSize = buf.readUInt32LE(idx + 20);
    const localOffset = buf.readUInt32LE(idx + 42);
    const name = buf.toString('utf8', idx + 46, idx + 46 + nameLen);
    void extraLen;
    void commentLen;
    entries.push({ name, compressedSize, localOffset });
    idx = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), idx - 1);
  }
  for (const entry of entries) {
    names.push(entry.name);
    if (entry.name !== 'manifest.json') continue;
    // Local header: 30 bytes fixed + name + extra, then the payload.
    const lh = entry.localOffset;
    const nameLen = buf.readUInt16LE(lh + 26);
    const extraLen = buf.readUInt16LE(lh + 28);
    const start = lh + 30 + nameLen + extraLen;
    const method = buf.readUInt16LE(lh + 8);
    const raw = buf.subarray(start, start + entry.compressedSize);
    // 0 = stored, 8 = deflate. Anything else means the package was built with
    // a tool this script cannot read, which is a packaging change worth seeing.
    if (method === 0) {
      manifest = JSON.parse(raw.toString('utf8'));
    } else if (method === 8) {
      manifest = JSON.parse(inflateRawSync(raw).toString('utf8'));
    } else {
      problems.push(`${file}: manifest.json uses unsupported compression method ${method}`);
    }
  }
  return { names, manifest };
}

const artifacts = [
  { key: 'file', target: 'chromium', label: 'Chromium MV3' },
  { key: 'firefoxFile', target: 'firefox', label: 'Firefox MV3' },
];

for (const artifact of artifacts) {
  const name = release[artifact.key];
  if (!name) {
    problems.push(`${artifact.label}: release.json has no "${artifact.key}"`);
    continue;
  }
  const path = join(extDir, name);
  if (!existsSync(path)) {
    problems.push(`${artifact.label}: ${name} is missing (packaged artifact not committed)`);
    continue;
  }
  const bytes = statSync(path).size;
  const digest = sha256(path);
  const { names, manifest } = readZip(path);

  if (!names.includes('manifest.json') || !names.includes('popup.js') || !names.includes('popup.html')) {
    problems.push(`${artifact.label}: ${name} does not contain manifest.json/popup.js/popup.html`);
  }
  if (manifest) {
    if (manifest.version !== release.version) {
      problems.push(`${artifact.label}: packaged manifest version ${manifest.version} ≠ release.json ${release.version}`);
    }
    const perms = [...(manifest.permissions || [])].sort().join(',');
    if (perms !== [...release.permissions].sort().join(',')) {
      problems.push(`${artifact.label}: packaged permissions [${perms}] ≠ release.json [${release.permissions.join(',')}]`);
    }
    if (artifact.target === 'firefox') {
      const id = manifest.browser_specific_settings?.gecko?.id;
      if (!id) problems.push(`${artifact.label}: packaged manifest has no gecko id`);
      if (manifest.minimum_chrome_version) {
        problems.push(`${artifact.label}: packaged manifest carries minimum_chrome_version`);
      }
    } else if (!manifest.minimum_chrome_version) {
      problems.push(`${artifact.label}: packaged manifest has no minimum_chrome_version`);
    }
  }

  if (write) {
    release[artifact.key] = name;
    if (artifact.key === 'file') {
      release.bytes = bytes;
      release.sha256 = digest;
    } else {
      release.firefoxBytes = bytes;
      release.firefoxSha256 = digest;
    }
    continue;
  }

  if (artifact.key === 'file') {
    if (release.bytes !== bytes) problems.push(`${name}: ${bytes} bytes on disk, release.json says ${release.bytes}`);
    if (release.sha256 !== digest) problems.push(`${name}: sha256 ${digest} ≠ release.json ${release.sha256}`);
    if (release.manifestVersion !== 3) problems.push(`release.json manifestVersion is ${release.manifestVersion}`);
  } else {
    if (release.firefoxBytes !== bytes) problems.push(`${name}: ${bytes} bytes on disk, release.json says ${release.firefoxBytes}`);
    if (release.firefoxSha256 !== digest) problems.push(`${name}: sha256 ${digest} ≠ release.json ${release.firefoxSha256}`);
  }
}

// The packaged (not published) state is a product claim on /download.
if (release.storePublished !== false) {
  problems.push('release.json storePublished must be false while nothing is in a store');
}

if (write) {
  const newest = artifacts
    .map((a) => join(extDir, release[a.key]))
    .filter(existsSync)
    .map((f) => statSync(f).mtime)
    .sort((a, b) => b - a)[0];
  if (newest) release.builtAt = newest.toISOString().slice(0, 10);
  writeFileSync(releasePath, `${JSON.stringify(release, null, 2)}\n`);
  console.log(`release.json updated: v${release.version} (${release.builtAt})`);
}

if (problems.length > 0) {
  console.error('release artifact problems:');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nRepackage the extension, then run: npm run release:extension -- --write');
  process.exit(1);
}

console.log(
  `release artifacts OK: v${release.version} · ${release.file} ${release.bytes} B sha256 ${release.sha256.slice(0, 12)}… · `
  + `${release.firefoxFile} ${release.firefoxBytes} B sha256 ${release.firefoxSha256.slice(0, 12)}…`
);
