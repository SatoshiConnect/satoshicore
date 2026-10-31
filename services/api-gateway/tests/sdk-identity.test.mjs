// STRICT network-identity verification tests for lib/nsatClient.js.
//
// These are the wallet's identity WIND-TUNNEL tests: they drive
// verifyNetworkIdentity() against a REAL gateway (server.js) + mock core
// and assert the exact-match, fail-closed semantics for every state the
// directive names. Run from services/api-gateway:
//     node --test tests/sdk-identity.test.mjs
//
// Scenarios (directive §4):
//   1. exact Mainnet match → ok
//   2. Devnet masquerading as Mainnet → refusal (never accepted)
//   3. matching prefix with different suffix → refusal (both directions)
//   4. extra whitespace variants → refusal (byte-for-byte compare)
//   5. empty network string → refusal
//   6. malformed gateway response (network missing / non-string) → refusal
//   7. gateway outage → refusal
//   8. blank configured identity (explicit override) → fail closed
//   9. identity changes between two verifications → second check refuses
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SDK_URL = new URL('../../../lib/nsatClient.js', import.meta.url).href;

const MAINNET = 'NSAT Mainnet ; October 2026 ; bc3098829fffc717';
const DEVNET = 'SatoshiCore Disposable Devnet ; 5531a2d390f227ce629adacc794b6487';

// One mock core serving /info with the scenario's identity. Returned server
// carries `swapReport(newName)` for mid-session drift tests.
function startMockCore(network) {
  let report = network;
  const server = http.createServer((req, res) => {
    if (req.url === '/info') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        info: {
          ledger: { num: 80800, baseFee: 10, baseReserve: 100000000, version: 1 },
          network: report,
        },
      }));
    } else {
      res.writeHead(404);
      res.end('{}');
    }
  });
  server.swapReport = (n) => { report = n; };
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function startGateway(corePort) {
  process.env.NSAT_CORE_HTTP_URL = `http://127.0.0.1:${corePort}`;
  delete require.cache[require.resolve('../server.js')];
  const { createServer: freshCreate } = require('../server.js');
  const gateway = freshCreate();
  return new Promise((r) => gateway.listen(0, '127.0.0.1', () => r(gateway)));
}

// Fresh SDK module per scenario (the module binds env at import time; the
// query param busts the ESM cache for each new instance).
async function withScenario({ expected, coreReports, run }) {
  const mockCore = await startMockCore(coreReports);
  const gateway = await startGateway(mockCore.address().port);
  const hadId = process.env.NEXT_PUBLIC_NSAT_NETWORK_ID !== undefined;
  if (expected === undefined) delete process.env.NEXT_PUBLIC_NSAT_NETWORK_ID;
  else process.env.NEXT_PUBLIC_NSAT_NETWORK_ID = expected;
  process.env.NEXT_PUBLIC_API_GATEWAY_URL = `http://127.0.0.1:${gateway.address().port}`;
  try {
    const sdk = await import(`${SDK_URL}?scenario=${Date.now()}-${Math.random()}`);
    await run(sdk);
  } finally {
    if (hadId) process.env.NEXT_PUBLIC_NSAT_NETWORK_ID = MAINNET;
    else delete process.env.NEXT_PUBLIC_NSAT_NETWORK_ID;
    gateway.close();
    mockCore.close();
  }
}

test('1. exact Mainnet identity is accepted with null reason', async () => {
  await withScenario({
    expected: MAINNET, coreReports: MAINNET,
    run: async (sdk) => {
      const r = await sdk.verifyNetworkIdentity();
      assert.equal(r.ok, true);
      assert.equal(r.reason, null);
    },
  });
});

test('2. Devnet masquerading is refused', async () => {
  await withScenario({
    expected: MAINNET, coreReports: DEVNET,
    run: async (sdk) => {
      const r = await sdk.verifyNetworkIdentity();
      assert.equal(r.ok, false);
      assert.ok(r.reason.includes('Devnet'), `reason mentions the real name: ${r.reason}`);
    },
  });
});

test('3. matching prefix with different suffix is refused (both directions)', async () => {
  // 3a: expected identity SHORTER than what the chain reports
  await withScenario({
    expected: 'NSAT Mainnet ; October 2026', coreReports: MAINNET,
    run: async (sdk) => {
      const r = await sdk.verifyNetworkIdentity();
      assert.equal(r.ok, false, 'shorter expected identity must fail against full chain name');
    },
  });
  // 3b: chain reports a single-character suffix mutation
  await withScenario({
    expected: MAINNET, coreReports: MAINNET.slice(0, -1) + '6',
    run: async (sdk) => {
      const r = await sdk.verifyNetworkIdentity();
      assert.equal(r.ok, false, 'mutated suffix must fail');
    },
  });
});

test('4. extra whitespace in the reported identity is refused', async () => {
  await withScenario({
    expected: MAINNET, coreReports: ` ${MAINNET} `,
    run: async (sdk) => {
      const r = await sdk.verifyNetworkIdentity();
      assert.equal(r.ok, false, 'padded identity must fail byte-for-byte comparison');
    },
  });
  await withScenario({
    expected: MAINNET, coreReports: MAINNET.replace('; ', ';  '),
    run: async (sdk) => {
      const r = await sdk.verifyNetworkIdentity();
      assert.equal(r.ok, false);
    },
  });
});

test('5. empty reported network is refused', async () => {
  await withScenario({
    expected: MAINNET, coreReports: '',
    run: async (sdk) => {
      const r = await sdk.verifyNetworkIdentity();
      assert.equal(r.ok, false);
      assert.ok(r.reason.includes('did not report'));
    },
  });
});

test('6. malformed response (network key null/absent) is refused', async () => {
  await withScenario({
    expected: MAINNET, coreReports: null, // mock sends network: null
    run: async (sdk) => {
      const r = await sdk.verifyNetworkIdentity();
      assert.equal(r.ok, false);
      assert.ok(r.reason.includes('did not report'));
      assert.equal(r.network, null);
    },
  });
});

test('7. gateway outage is refused and never masquerades as verified', async () => {
  const hadId = process.env.NEXT_PUBLIC_NSAT_NETWORK_ID !== undefined;
  delete process.env.NEXT_PUBLIC_NSAT_NETWORK_ID; // default = full Mainnet id
  process.env.NEXT_PUBLIC_API_GATEWAY_URL = 'http://127.0.0.1:1'; // dead target
  try {
    const sdk = await import(`${SDK_URL}?outage=${Date.now()}`);
    const r = await sdk.verifyNetworkIdentity();
    assert.equal(r.ok, false);
    assert.equal(r.network, null);
    assert.ok(r.reason.includes('unreachable'), `reason: ${r.reason}`);
  } finally {
    if (hadId) process.env.NEXT_PUBLIC_NSAT_NETWORK_ID = MAINNET;
    else delete process.env.NEXT_PUBLIC_NSAT_NETWORK_ID;
  }
});

test('8. blank configured identity (explicit override) fails closed with config guidance', async () => {
  await withScenario({
    expected: '', coreReports: MAINNET,
    run: async (sdk) => {
      const r = await sdk.verifyNetworkIdentity();
      assert.equal(r.ok, false);
      assert.ok(r.reason.includes('NEXT_PUBLIC_NSAT_NETWORK_ID'), r.reason);
    },
  });
});

test('9. identity changes between two verifications → the drift is caught', async () => {
  const mockCore = await startMockCore(MAINNET);
  const gateway = await startGateway(mockCore.address().port);
  process.env.NEXT_PUBLIC_NSAT_NETWORK_ID = MAINNET;
  process.env.NEXT_PUBLIC_API_GATEWAY_URL = `http://127.0.0.1:${gateway.address().port}`;
  const { swapReport } = mockCore;
  try {
    const sdk = await import(`${SDK_URL}?recheck=${Date.now()}`);
    const first = await sdk.verifyNetworkIdentity();
    assert.equal(first.ok, true);
    // …the reported identity changes mid-session (simulated malicious core swap)
    swapReport(DEVNET);
    const second = await sdk.verifyNetworkIdentity();
    assert.equal(second.ok, false, 'identity drift between verifications MUST fail');
    assert.notEqual(second.network, MAINNET);
  } finally {
    process.env.NEXT_PUBLIC_NSAT_NETWORK_ID = MAINNET;
    gateway.close();
    mockCore.close();
  }
});
