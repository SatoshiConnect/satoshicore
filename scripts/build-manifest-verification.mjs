import { createHash } from 'node:crypto';

const SHA256_RE = /^[a-f0-9]{64}$/i;
const COMMIT_RE = /^[a-f0-9]{40}$/i;

export function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function validateBuildManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('build manifest is not a JSON object');
  }
  if (manifest.schemaVersion !== 1) {
    throw new Error(`unsupported build manifest schema ${manifest.schemaVersion}`);
  }
  if (!COMMIT_RE.test(String(manifest.commit || ''))) {
    throw new Error('build manifest has no valid 40-character commit');
  }
  if (!manifest.environment || typeof manifest.environment !== 'object') {
    throw new Error('build manifest has no environment flags');
  }
  for (const name of ['index.html', 'sw.js']) {
    if (!SHA256_RE.test(String(manifest.files?.[name] || ''))) {
      throw new Error(`build manifest has no valid SHA-256 for ${name}`);
    }
  }
  return manifest;
}

export function compareBuildManifests(expected, actual) {
  validateBuildManifest(expected);
  validateBuildManifest(actual);
  const mismatches = [];
  if (expected.commit.toLowerCase() !== actual.commit.toLowerCase()) {
    mismatches.push(`commit expected ${expected.commit}, production reports ${actual.commit}`);
  }
  if (JSON.stringify(expected.environment) !== JSON.stringify(actual.environment)) {
    mismatches.push('environment flags differ from the tested build');
  }
  for (const name of ['index.html', 'sw.js']) {
    if (expected.files[name].toLowerCase() !== actual.files[name].toLowerCase()) {
      mismatches.push(`${name} SHA-256 differs from the tested build`);
    }
  }
  if (Boolean(expected.workingTreeDirty) !== Boolean(actual.workingTreeDirty)) {
    mismatches.push('workingTreeDirty flag differs from the tested build');
  }
  return mismatches;
}

function appendCacheBuster(input) {
  const result = new URL(input);
  result.searchParams.set('__build_verify', `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return result;
}

export async function verifyRemoteBuild({
  base,
  expectedManifest,
  expectedCommit,
  fetchImpl = fetch,
  timeoutMs = 15_000,
} = {}) {
  const root = new URL(base);
  const fetchFresh = async (path) => {
    const target = appendCacheBuster(new URL(path.replace(/^\//, ''), root));
    const response = await fetchImpl(target, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
    return response;
  };

  const manifestResponse = await fetchFresh('build-manifest.json');
  const contentType = manifestResponse.headers.get('content-type') || '';
  if (!/json/i.test(contentType)) {
    throw new Error(`build-manifest.json served as ${contentType || 'no content-type'}, expected JSON`);
  }
  const actual = validateBuildManifest(await manifestResponse.json());
  if (expectedManifest) {
    const mismatches = compareBuildManifests(expectedManifest, actual);
    if (mismatches.length) throw new Error(mismatches.join('; '));
  }
  if (expectedCommit && actual.commit.toLowerCase() !== String(expectedCommit).toLowerCase()) {
    throw new Error(`commit expected ${expectedCommit}, production reports ${actual.commit}`);
  }
  if (!expectedManifest && !expectedCommit) {
    throw new Error('no tested build manifest or expected commit was provided for comparison');
  }

  const served = {};
  for (const name of ['index.html', 'sw.js']) {
    const response = await fetchFresh(name);
    served[name] = await response.text();
    const digest = sha256Text(served[name]);
    if (digest.toLowerCase() !== actual.files[name].toLowerCase()) {
      throw new Error(`${name} served hash ${digest} does not match production manifest ${actual.files[name]}`);
    }
    if (expectedManifest && digest.toLowerCase() !== expectedManifest.files[name].toLowerCase()) {
      throw new Error(`${name} served hash differs from the build/CI-tested artifact`);
    }
  }

  return {
    commit: actual.commit,
    workingTreeDirty: Boolean(actual.workingTreeDirty),
    environment: actual.environment,
    hashes: {
      'index.html': sha256Text(served['index.html']),
      'sw.js': sha256Text(served['sw.js']),
    },
  };
}
