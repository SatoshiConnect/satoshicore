import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compareBuildManifests, sha256Text, validateBuildManifest, verifyRemoteBuild,
} from '../scripts/build-manifest-verification.mjs';

const commit = 'a'.repeat(40);
const html = '<!doctype html><title>tested build</title>';
const sw = 'self.addEventListener("fetch",()=>{});';
const manifest = (overrides = {}) => ({
  schemaVersion: 1,
  commit,
  workingTreeDirty: false,
  environment: { basePath: '', chatRelayEnabled: true, apiSameOrigin: true },
  files: { 'index.html': sha256Text(html), 'sw.js': sha256Text(sw) },
  ...overrides,
});

function fakeFetch(files, requests = []) {
  return async (input, init) => {
    const url = new URL(input);
    requests.push({ url, init });
    const path = url.pathname.split('/').pop();
    const value = files[path];
    if (value == null) return new Response('not found', { status: 404 });
    const type = path.endsWith('.json') ? 'application/json' : path.endsWith('.js')
      ? 'application/javascript' : 'text/html';
    return new Response(typeof value === 'string' ? value : JSON.stringify(value), {
      status: 200, headers: { 'content-type': type },
    });
  };
}

test('build manifest validation rejects malformed commit and file hashes', () => {
  assert.equal(validateBuildManifest(manifest()).commit, commit);
  assert.throws(() => validateBuildManifest(manifest({ commit: 'bad' })), /commit/);
  assert.throws(() => validateBuildManifest(manifest({ files: { 'index.html': 'bad', 'sw.js': sha256Text(sw) } })), /index.html/);
});

test('manifest comparison includes commit, safe flags, dirty status and hashes', () => {
  assert.deepEqual(compareBuildManifests(manifest(), manifest()), []);
  const changed = manifest({
    commit: 'b'.repeat(40),
    environment: { basePath: '/preview', chatRelayEnabled: false, apiSameOrigin: true },
    workingTreeDirty: true,
    files: { 'index.html': 'b'.repeat(64), 'sw.js': 'c'.repeat(64) },
  });
  const mismatches = compareBuildManifests(manifest(), changed);
  assert.equal(mismatches.length, 5);
  assert.match(mismatches.join(' '), /commit/);
  assert.match(mismatches.join(' '), /environment/);
  assert.match(mismatches.join(' '), /index.html/);
  assert.match(mismatches.join(' '), /sw.js/);
  assert.match(mismatches.join(' '), /workingTreeDirty/);
});

test('remote verifier fetches manifest and files cache-busted and matches tested hashes', async () => {
  const requests = [];
  const expected = manifest();
  const result = await verifyRemoteBuild({
    base: 'https://wallet.example/subpath/',
    expectedManifest: expected,
    fetchImpl: fakeFetch({
      'build-manifest.json': expected,
      'index.html': html,
      'sw.js': sw,
    }, requests),
  });
  assert.equal(result.commit, commit);
  assert.deepEqual(result.hashes, { 'index.html': sha256Text(html), 'sw.js': sha256Text(sw) });
  assert.equal(requests.length, 3);
  assert.ok(requests.every(({ url }) => url.searchParams.has('__build_verify')));
  assert.ok(requests.every(({ init }) => init.cache === 'no-store'));
  assert.ok(requests[0].url.pathname.endsWith('/subpath/build-manifest.json'));
});

test('remote verifier rejects a stale artifact even when production self-manifest is internally consistent', async () => {
  const actual = manifest({ commit: 'b'.repeat(40), files: {
    'index.html': sha256Text('<html>old</html>'),
    'sw.js': sha256Text('old sw'),
  } });
  await assert.rejects(() => verifyRemoteBuild({
    base: 'https://wallet.example/',
    expectedManifest: manifest(),
    fetchImpl: fakeFetch({
      'build-manifest.json': actual,
      'index.html': '<html>old</html>',
      'sw.js': 'old sw',
    }),
  }), /commit expected|index\.html SHA-256|sw\.js SHA-256/);
});

test('remote verifier rejects files that disagree with the served manifest', async () => {
  const actual = manifest();
  await assert.rejects(() => verifyRemoteBuild({
    base: 'https://wallet.example/',
    expectedCommit: commit,
    fetchImpl: fakeFetch({
      'build-manifest.json': actual,
      'index.html': '<html>tampered</html>',
      'sw.js': sw,
    }),
  }), /index\.html served hash/);
});

test('remote verification requires an expected manifest or commit', async () => {
  await assert.rejects(() => verifyRemoteBuild({
    base: 'https://wallet.example/', fetchImpl: fakeFetch({ 'build-manifest.json': manifest() }),
  }), /no tested build manifest/);
});
