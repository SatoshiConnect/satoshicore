// API Gateway tests: unit (validation) + integration (mock nsat-core node).
// Run: node --test tests/
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer, validateEnvelope } = require('../server.js');

const VALID_ENVELOPE = Buffer.from('test-envelope-bytes').toString('base64');

// --- unit: envelope validation ----------------------------------------------
test('validateEnvelope accepts valid base64 envelope', () => {
  assert.equal(validateEnvelope(VALID_ENVELOPE), null);
});

test('validateEnvelope rejects non-base64, oversized, and non-string', () => {
  assert.ok(validateEnvelope('not base64!!'));
  assert.ok(validateEnvelope('A'.repeat(9000)));
  assert.ok(validateEnvelope(123));
  assert.ok(validateEnvelope(null));
});

// --- integration: mock core + gateway ---------------------------------------
function startMockCore() {
  const server = http.createServer((req, res) => {
    if (req.url === '/info') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ info: { ledger: { num: 42 }, network: 'SatoshiCore Testnet ; October 2026' } }));
    } else if (req.url.startsWith('/tx?blob=')) {
      const blob = decodeURIComponent(req.url.slice('/tx?blob='.length));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'PENDING', hash: 'deadbeef', received_blob: blob }));
    } else {
      res.writeHead(404);
      res.end('{}');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function request(port, path, { method = 'GET', body = null, origin } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method,
        headers: { ...(origin ? { Origin: origin } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('gateway: health, chain info proxy, signed tx relay, CORS, 404', async () => {
  const mockCore = await startMockCore();
  const corePort = mockCore.address().port;

  process.env.NSAT_CORE_HTTP_URL = `http://127.0.0.1:${corePort}`;
  process.env.ALLOWED_ORIGINS = 'https://satoshicore.org';
  process.env.RATE_MAX_REQUESTS = '1000';
  delete require.cache[require.resolve('../server.js')];
  const { createServer: freshCreate } = require('../server.js');

  const gateway = freshCreate();
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  const gwPort = gateway.address().port;

  try {
    // health
    const health = await request(gwPort, '/health');
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body).service, 'satoshicore-api-gateway');

    // chain info proxied from core
    const info = await request(gwPort, '/api/v1/chain/info', { origin: 'https://satoshicore.org' });
    assert.equal(info.status, 200);
    const infoBody = JSON.parse(info.body);
    assert.equal(infoBody.info.ledger.num, 42);
    assert.equal(info.headers['access-control-allow-origin'], 'https://satoshicore.org');

    // CORS rejected for unknown origin
    const badOrigin = await request(gwPort, '/api/v1/chain/info', { origin: 'https://evil.example' });
    assert.equal(badOrigin.headers['access-control-allow-origin'], undefined);

    // signed tx relay — envelope forwarded verbatim to core
    const tx = await request(gwPort, '/api/v1/tx', {
      method: 'POST',
      body: JSON.stringify({ envelope_xdr: VALID_ENVELOPE })
    });
    assert.equal(tx.status, 200);
    const txBody = JSON.parse(tx.body);
    assert.equal(txBody.status, 'PENDING');
    assert.equal(txBody.received_blob, VALID_ENVELOPE);

    // invalid envelope rejected before touching core
    const badTx = await request(gwPort, '/api/v1/tx', {
      method: 'POST',
      body: JSON.stringify({ envelope_xdr: '!!!' })
    });
    assert.equal(badTx.status, 400);

    // unknown route 404 (no wildcard proxy — admin core endpoints unreachable)
    const admin = await request(gwPort, '/bands');
    assert.equal(admin.status, 404);
    const random = await request(gwPort, '/http-command');
    assert.equal(random.status, 404);
  } finally {
    gateway.close();
    mockCore.close();
  }
});
