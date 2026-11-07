// Tests for the read-only confirmation routes:
//   GET /v1/confirmations/{hash}
//   GET /v1/accounts/{G...}/events
// A mock core provides the chain identity, a mock indexer provides verdicts and
// an event stream, and the gateway is loaded with its own environment per test
// because CONFIG is captured at require time.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const MAINNET = 'NSAT Mainnet ; October 2026 ; bc3098829fffc717';
const HASH = 'a'.repeat(64);
const G = 'G' + 'A'.repeat(55);

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const url = (s) => `http://127.0.0.1:${s.address().port}`;

function loadGateway(env) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = String(v);
  }
  const resolved = require.resolve('../server.js');
  delete require.cache[resolved];
  const mod = require(resolved);
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  return { mod, restore };
}

function get(port, pathname, { method = 'GET', headers = {}, readBody = true } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      let body = '';
      if (!readBody) return resolve({ status: res.statusCode, headers: res.headers, stream: res });
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function withStack(t, { env = {}, indexer, core } = {}) {
  const coreServer = await startServer(
    core ||
      ((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ info: { ledger: { num: 1 }, network: MAINNET } }));
      })
  );
  const indexerHits = [];
  const indexerServer = await startServer((req, res) => {
    indexerHits.push({ url: req.url, lastEventId: req.headers['last-event-id'] || null });
    if (indexer) return indexer(req, res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ hash: HASH, status: 'confirmed', result_code: 'txSUCCESS', ledger: 5, evidence: 'live_ledger_meta' }));
  });
  const { mod, restore } = loadGateway({
    NSAT_CORE_HTTP_URL: url(coreServer),
    NSAT_INDEXER_URL: url(indexerServer),
    NSAT_EXPECTED_NETWORK: MAINNET,
    NSAT_GATEWAY_HOST: '127.0.0.1',
    ...env
  });
  const gateway = mod.createServer();
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const port = gateway.address().port;

  t.after(async () => {
    await new Promise((r) => gateway.close(r));
    coreServer.close();
    indexerServer.close();
    restore();
  });
  return { port, indexerHits, gateway };
}

test('confirmation proxies the exact-hash verdict', async (t) => {
  const { port, indexerHits } = await withStack(t);
  const res = await get(port, `/v1/confirmations/${HASH}?submitted_at=1700000000`);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.status, 'confirmed');
  assert.equal(body.evidence, 'live_ledger_meta');
  assert.equal(indexerHits[0].url, `/v1/confirmations/${HASH}?submitted_at=1700000000`);
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('confirmation rejects malformed hashes before touching the indexer', async (t) => {
  const { port, indexerHits } = await withStack(t);
  for (const bad of ['abc', 'A'.repeat(64), 'z'.repeat(64), `${'a'.repeat(63)}g`]) {
    const res = await get(port, `/v1/confirmations/${bad}`);
    assert.equal(res.status, 400, `expected 400 for ${bad}`);
    assert.match(JSON.parse(res.body).error, /64 lowercase hex/);
  }
  assert.equal(indexerHits.length, 0);
});

test('events rejects a malformed account before touching the indexer', async (t) => {
  const { port, indexerHits } = await withStack(t);
  for (const bad of ['GABC', 'X' + 'A'.repeat(55), 'G' + 'a'.repeat(55)]) {
    const res = await get(port, `/v1/accounts/${bad}/events?since=0`);
    assert.equal(res.status, 400);
  }
  assert.equal(indexerHits.length, 0);
});

test('both routes refuse a chain whose identity is not the expected one', async (t) => {
  const otherNetwork = 'NSAT Testnet ; January 2026 ; deadbeef';
  const { port, indexerHits } = await withStack(t, {
    core: (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ info: { ledger: { num: 1 }, network: otherNetwork } }));
    }
  });
  const conf = await get(port, `/v1/confirmations/${HASH}`);
  assert.equal(conf.status, 503);
  assert.match(JSON.parse(conf.body).error, /identity/i);
  const events = await get(port, `/v1/accounts/${G}/events?since=0`);
  assert.equal(events.status, 503);
  assert.equal(indexerHits.length, 0);
});

test('fail closed when the core (identity source) is unreachable', async (t) => {
  const { port } = await withStack(t, {
    core: (req, res) => {
      req.destroy();
      res.destroy();
    }
  });
  const res = await get(port, `/v1/confirmations/${HASH}`);
  assert.equal(res.status, 503);
});

test('fail closed when the indexer is unreachable or errors', async (t) => {
  const { port } = await withStack(t, {
    indexer: (req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal detail that must not leak' }));
    }
  });
  const res = await get(port, `/v1/confirmations/${HASH}`);
  assert.equal(res.status, 503);
  assert.doesNotMatch(res.body, /internal detail/);
});

test('non-GET methods are rejected with 405 and an Allow header', async (t) => {
  const { port } = await withStack(t);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const res = await get(port, `/v1/confirmations/${HASH}`, { method });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.allow, 'GET');
  }
});

test('events stream without buffering and forward Last-Event-ID', async (t) => {
  const { port, indexerHits } = await withStack(t, {
    indexer: (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('id: 431\ndata: {"ledger":431}\n\n');
      setTimeout(() => {
        res.write('id: 432\ndata: {"ledger":432}\n\n');
        res.end();
      }, 20);
    }
  });
  const res = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: `/v1/accounts/${G}/events?since=430`, headers: { 'Last-Event-ID': '431' } },
      resolve
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/event-stream/);
  assert.equal(res.headers['x-accel-buffering'], 'no');
  assert.equal(res.headers['cache-control'], 'no-store');

  let body = '';
  res.setEncoding('utf8');
  await new Promise((resolve) => {
    res.on('data', (c) => (body += c));
    res.on('end', resolve);
  });
  assert.match(body, /id: 431/);
  assert.match(body, /id: 432/);
  assert.equal(indexerHits[0].lastEventId, '431');
});

test('concurrent event streams are bounded', async (t) => {
  const { port } = await withStack(t, {
    env: { INDEXER_MAX_STREAMS: 1 },
    indexer: (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('id: 1\ndata: {}\n\n'); // stays open
    }
  });
  const first = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: `/v1/accounts/${G}/events?since=0` }, resolve);
    req.on('error', reject);
    req.end();
  });
  assert.equal(first.statusCode, 200);

  const second = await get(port, `/v1/accounts/${G}/events?since=0`);
  assert.equal(second.status, 503);
  assert.match(JSON.parse(second.body).error, /too many/i);

  first.destroy();
});

test('the gateway rate limit still guards the new routes', async (t) => {
  const { port } = await withStack(t, { env: { RATE_MAX_REQUESTS: 2, RATE_WINDOW_MS: 60_000 } });
  const codes = [];
  for (let i = 0; i < 4; i += 1) codes.push((await get(port, `/v1/confirmations/${HASH}`)).status);
  assert.deepEqual(codes.slice(0, 2), [200, 200]);
  assert.deepEqual(codes.slice(2), [429, 429]);
});

// The same-origin wallet points its indexer base URL at this gateway, so the
// three read routes below must behave like the indexer's own GETs: pass a 200
// through untouched, keep the indexer's 404 so "no such tx" is distinguishable
// from "index down", and never let a malformed id reach the upstream.
test('health, tx detail and account history are proxied read-only', async (t) => {
  const seen = [];
  const { port } = await withStack(t, {
    indexer: (req, res) => {
      seen.push(req.url);
      if (req.url === '/v1/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, indexed_head: 12, ledgers: 12 }));
      }
      if (req.url.startsWith('/v1/tx/')) {
        if (req.url.endsWith('b'.repeat(64))) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'not found' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ hash: HASH, ledger: 5 }));
      }
      if (req.url.startsWith('/v1/accounts/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ account: G, transactions: [] }));
      }
      res.writeHead(500).end('{}');
    }
  });

  const health = await get(port, '/v1/health');
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).ok, true);
  assert.equal(health.headers['cache-control'], 'no-store');

  const tx = await get(port, `/v1/tx/${HASH}`);
  assert.equal(tx.status, 200);
  assert.equal(JSON.parse(tx.body).hash, HASH);

  const missing = await get(port, `/v1/tx/${'b'.repeat(64)}`);
  assert.equal(missing.status, 404, 'an unknown hash stays a 404, not a 503');

  const history = await get(port, `/v1/accounts/${G}/transactions?limit=9999`);
  assert.equal(history.status, 200);
  assert.ok(seen.includes(`/v1/accounts/${G}/transactions?limit=${200}`), 'limit is clamped');
});

test('the new read routes reject malformed ids before the indexer', async (t) => {
  const { port, indexerHits } = await withStack(t);
  const badHash = await get(port, `/v1/tx/${'A'.repeat(64)}`);
  assert.equal(badHash.status, 400);
  const badAccount = await get(port, '/v1/accounts/not-an-account/transactions');
  assert.equal(badAccount.status, 400);
  const badMethod = await get(port, '/v1/health', { method: 'POST' });
  assert.equal(badMethod.status, 405);
  assert.equal(badMethod.headers.allow, 'GET');
  assert.equal(indexerHits.length, 0);
});

test('the new read routes still fail closed on identity mismatch', async (t) => {
  const { port, indexerHits } = await withStack(t, {
    core: (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ info: { ledger: { num: 1 }, network: 'NSAT Testnet ; January 2026 ; deadbeef' } }));
    }
  });
  assert.equal((await get(port, '/v1/health')).status, 503);
  assert.equal((await get(port, `/v1/tx/${HASH}`)).status, 503);
  assert.equal((await get(port, `/v1/accounts/${G}/transactions`)).status, 503);
  assert.equal(indexerHits.length, 0);
});
