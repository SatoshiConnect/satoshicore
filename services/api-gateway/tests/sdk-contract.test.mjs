// SDK ↔ Gateway contract tests.
//
// Drives the real browser SDK (satoshicore-web/lib/nsatClient.js — the same
// module the web wallet ships) against a REAL gateway instance (server.js)
// with a mock nsat-core upstream. This binds three layers so the SDK can
// never drift from the versioned /api/v1 contract silently.
//
// Run from services/api-gateway:  node --test tests/sdk-contract.test.mjs
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = new URL('.', import.meta.url).pathname;
const SDK_URL = new URL('../../../lib/nsatClient.js', import.meta.url).href;

const G_STRKEY = 'GBNVPJVAP2DF4J6OFBSAHNN6CMVYKY2BVEMME2KVWNW66522BQT5G6OW';
const VALID_ENVELOPE = Buffer.from('contract-test-envelope-bytes').toString('base64');

const posted = [];

function startMockCore() {
  const server = http.createServer((req, res) => {
    if (req.url === '/info') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        info: {
          ledger: { num: 80800, baseFee: 10, baseReserve: 100000000, version: 1 },
          network: 'NSAT Mainnet ; October 2026 ; bc3098829fffc717'
        }
      }));
    } else if (req.url.startsWith('/account?acc=')) {
      const acc = decodeURIComponent(req.url.slice('/account?acc='.length));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: acc, status: 'ok',
        balance: 123, balance128: '2100000000000000000000000',
        seqnum: 5
      }));
    } else if (req.url.startsWith('/tx?blob=')) {
      const blob = decodeURIComponent(req.url.slice('/tx?blob='.length));
      posted.push(blob);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'PENDING', hash: 'deadbeef', received_blob: blob }));
    } else {
      res.writeHead(404);
      res.end('{}');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('SDK speaks the exact /api/v1 contract of a real gateway', async () => {
  const mockCore = await startMockCore();
  process.env.NSAT_CORE_HTTP_URL = `http://127.0.0.1:${mockCore.address().port}`;
  // (Gateway no longer reports env-configured names; NSAT_NETWORK_NAME env
  // is deliberately not set anywhere.)
  const gateway = require('../server.js').createServer();
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));

  // The SDK binds its gateway URL + expected identity at import time.
  // The expected identity MUST be the full exact passphrase — the mock core
  // below reports exactly that, so this is the strict exact-match happy path.
  process.env.NEXT_PUBLIC_API_GATEWAY_URL = `http://127.0.0.1:${gateway.address().port}`;
  process.env.NEXT_PUBLIC_NSAT_NETWORK_ID = 'NSAT Mainnet ; October 2026 ; bc3098829fffc717';
  const sdk = await import(SDK_URL);

  try {
    // chain info contract
    const info = await sdk.getChainInfo();
    assert.equal(info.info.ledger.num, 80800);
    assert.equal(info.info.ledger.baseFee, 10);

    // network identity check (the wallet rejects mismatches before enabling send)
    const identity = await sdk.verifyNetworkIdentity();
    assert.equal(identity.ok, true, `expected exact identity verified, got: ${identity.reason}`);
    assert.equal(identity.network, 'NSAT Mainnet ; October 2026 ; bc3098829fffc717');
    assert.equal(identity.reason, null);
    assert.equal(identity.ledger, 80800);

    // account lookup — exact decimal string balance, seqnum present
    const acc = await sdk.getAccount(G_STRKEY);
    assert.equal(acc.balance128, '2100000000000000000000000');
    assert.equal(acc.seqnum, 5);
    assert.equal(acc.id, G_STRKEY);
    assert.equal(/^21000000…$/u.test(String(acc.balance128)) || /^\d+$/.test(acc.balance128), true,
      'balance128 must arrive as an exact decimal string');
    // 128-bit-exact formatting path (BigInt-safe, never float)
    assert.equal(sdk.formatExactBalance(acc.balance128), '2,100,000,000,000,000,000,000,000');

    // A client configured with a SHORTER/prefix identity (“NSAT Mainnet ;
    // October 2026”) must REFUSE when the chain reports the full exact
    // passphrase — exact-match only, no prefix acceptance either direction.
    process.env.NEXT_PUBLIC_NSAT_NETWORK_ID = 'NSAT Mainnet ; October 2026';
    process.env.NEXT_PUBLIC_API_GATEWAY_URL = `http://127.0.0.1:${gateway.address().port}`;
    delete require.cache[require.resolve('../server.js')];
    const mismatchSdk = await import(`${SDK_URL}?mismatch-network=1`);
    const rejected = await mismatchSdk.verifyNetworkIdentity();
    assert.equal(rejected.ok, false, 'prefix-configured client must refuse');
    assert.ok(rejected.reason.includes('expected'));
    assert.equal(rejected.network, 'NSAT Mainnet ; October 2026 ; bc3098829fffc717');

    // fee estimation — integer baseFee straight from the proxied ledger header
    assert.equal(await sdk.estimateFee(), 10);

    // signed-envelope relay is a verbatim passthrough
    const submission = await sdk.submitSignedTransaction(VALID_ENVELOPE);
    assert.equal(submission.status, 'PENDING');
    assert.equal(submission.received_blob, VALID_ENVELOPE);
    assert.deepEqual(posted, [VALID_ENVELOPE]);

    // malformed account id → typed 400 error rejected at the gateway
    await assert.rejects(() => sdk.getAccount('not_a_strkey'),
      (e) => e.status === 400);
  } finally {
    gateway.close();
    mockCore.close();
  }
});
