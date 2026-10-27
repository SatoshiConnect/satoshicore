// API Gateway tests: unit (validation) + integration (mock nsat-core node).
// Run: node --test tests/
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer, validateEnvelope, validAccountId } = require('../server.js');

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
    } else if (req.url.startsWith('/account?acc=')) {
      const acc = decodeURIComponent(req.url.slice('/account?acc='.length));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ balance: 123, balance128: '123', seqnum: 7, id: acc, status: 'ok' }));
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

// --- integration: busy-retry, oversize, rate limit ----------------------------

// core that returns N busy responses before serving /info normally
function startFlakyCore(busyCount) {
  let hits = 0;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/info') {
        hits += 1;
        if (hits <= busyCount) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'busy' }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ info: { ledger: { num: 77 }, network: 'NSAT Mainnet ; October 2026' } }));
        }
      } else {
        res.writeHead(404);
        res.end('{}');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('busy responses retried with backoff, never surfaced as success', async () => {
  const mockCore = await startFlakyCore(2);
  process.env.NSAT_CORE_HTTP_URL = `http://127.0.0.1:${mockCore.address().port}`;
  process.env.CORE_BUSY_DELAY_MS = '10';
  process.env.CORE_BUSY_RETRIES = '4';
  delete require.cache[require.resolve('../server.js')];
  const { createServer: freshCreate } = require('../server.js');
  const gateway = freshCreate();
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  try {
    const info = await request(gateway.address().port, '/api/v1/chain/info');
    assert.equal(info.status, 200);
    const body = JSON.parse(info.body);
    assert.equal(body.info.ledger.num, 77);
    assert.equal(body.status, undefined);
  } finally {
    gateway.close();
    mockCore.close();
  }
});

// core that is busy forever → gateway must answer 503, not a fake result
test('permanently busy core yields explicit 503', async () => {
  const mockCore = await startFlakyCore(999);
  process.env.NSAT_CORE_HTTP_URL = `http://127.0.0.1:${mockCore.address().port}`;
  process.env.CORE_BUSY_DELAY_MS = '10';
  process.env.CORE_BUSY_RETRIES = '1';
  delete require.cache[require.resolve('../server.js')];
  const { createServer: freshCreate } = require('../server.js');
  const gateway = freshCreate();
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  try {
    const info = await request(gateway.address().port, '/api/v1/chain/info');
    assert.equal(info.status, 503);
    const body = JSON.parse(info.body);
    assert.equal(body.status, 'busy');
  } finally {
    gateway.close();
    mockCore.close();
  }
});

// oversized request body is rejected with 413
test('oversized POST body rejected with 413', async () => {
  const mockCore = await startMockCore();
  process.env.NSAT_CORE_HTTP_URL = `http://127.0.0.1:${mockCore.address().port}`;
  process.env.MAX_BODY_BYTES = '64';
  delete require.cache[require.resolve('../server.js')];
  const { createServer: freshCreate } = require('../server.js');
  const gateway = freshCreate();
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  try {
    const big = await request(gateway.address().port, '/api/v1/tx', {
      method: 'POST',
      body: JSON.stringify({ envelope_xdr: 'A'.repeat(200) })
    });
    assert.equal(big.status, 413);
  } finally {
    gateway.close();
    mockCore.close();
  }
});

// rate limiting triggers 429 after max requests
test('rate limit enforced per IP', async () => {
  const mockCore = await startMockCore();
  process.env.NSAT_CORE_HTTP_URL = `http://127.0.0.1:${mockCore.address().port}`;
  process.env.RATE_MAX_REQUESTS = '5';
  process.env.RATE_WINDOW_MS = '60000';
  delete require.cache[require.resolve('../server.js')];
  const { createServer: freshCreate } = require('../server.js');
  const gateway = freshCreate();
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  try {
    const statuses = [];
    for (let i = 0; i < 7; i += 1) {
      const r = await request(gateway.address().port, '/api/v1/chain/info');
      statuses.push(r.status);
    }
    const firstFive = statuses.slice(0, 5);
    for (const s of firstFive) assert.ok(s !== 429, 'rate limit triggered before limit');
    assert.ok(statuses.includes(429), `expected 429 in ${statuses.join(',')}`);
  } finally {
    gateway.close();
    mockCore.close();
  }
});

// network status endpoint reports core liveness
test('network status endpoint reports gateway+core', async () => {
  const mockCore = await startMockCore();
  process.env.NSAT_CORE_HTTP_URL = `http://127.0.0.1:${mockCore.address().port}`;
  process.env.NSAT_NETWORK_NAME = 'NSAT Mainnet ; October 2026';
  delete require.cache[require.resolve('../server.js')];
  const { createServer: freshCreate } = require('../server.js');
  const gateway = freshCreate();
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  try {
    const r = await request(gateway.address().port, '/api/v1/network/status');
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.gateway, 'ok');
    assert.equal(body.core, 'ok');
    assert.equal(body.network, 'NSAT Mainnet ; October 2026');
  } finally {
    gateway.close();
    mockCore.close();
  }
});

// account proxy: valid strkey passthrough + strict validation
test('account route validates G-strkey and proxies reads', async () => {
  assert.equal(validAccountId(
    'GBNVPJVAP2DF4J6OFBSAHNN6CMVYKY2BVEMME2KVWNW66522BQT5G6OW'), true);
  assert.equal(validAccountId('short'), false);
  assert.equal(validAccountId('MABC' + 'A'.repeat(52)), false);
  assert.equal(validAccountId('G' + '0'.repeat(55)), false); // invalid base32

  const mockCore = await startMockCore();
  process.env.NSAT_CORE_HTTP_URL = `http://127.0.0.1:${mockCore.address().port}`;
  delete require.cache[require.resolve('../server.js')];
  const { createServer: freshCreate } = require('../server.js');
  const gateway = freshCreate();
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  try {
    const acc = 'GBNVPJVAP2DF4J6OFBSAHNN6CMVYKY2BVEMME2KVWNW66522BQT5G6OW';
    const ok = await request(gateway.address().port, `/api/v1/account?acc=${acc}`);
    assert.equal(ok.status, 200);
    const body = JSON.parse(ok.body);
    assert.equal(body.balance128, '123');
    const bad = await request(gateway.address().port, '/api/v1/account?acc=not_a_strkey');
    assert.equal(bad.status, 400);
  } finally {
    gateway.close();
    mockCore.close();
  }
});

// oversized request body is rejected with 413
