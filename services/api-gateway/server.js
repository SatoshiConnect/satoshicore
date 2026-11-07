// SatoshiCore Web Wallet API Gateway — production service (separate backend).
//
// Connects browser clients to the nsat-core node HTTP interface
// (default http://127.0.0.1:11626).
//
// Security invariants (SECURITY.md):
//  - The gateway NEVER holds or handles private keys or seeds. Transaction
//    signing is client-side; the gateway only relays already-signed
//    envelopes to the core node.
//  - Read-only proxy of the core's public /info endpoint, plus signed-tx
//    submission. No administrative core endpoints (bans, upgrades, forced
//    ledger ops) are proxied — allowlist only.
//  - Zero runtime dependencies to minimize supply-chain surface.
//  - All configuration via environment variables; no secrets committed.
'use strict';

const http = require('node:http');
const { URL } = require('node:url');

const CONFIG = {
  port: Number(process.env.PORT) || 8787,
  // Bind address. Empty = all interfaces (required only for the
  // production TLS-terminating reverse proxy). Disposable/local instances
  // (devnet tests, WALLET-DEVNET) must set NSAT_GATEWAY_HOST=127.0.0.1 so
  // the disposable network is never reachable from the LAN.
  bindHost: process.env.NSAT_GATEWAY_HOST || '',
  coreHttpUrl: (process.env.NSAT_CORE_HTTP_URL || 'http://127.0.0.1:11626').replace(/\/$/, ''),
  // Comma-separated origin allowlist for browser clients; '*' disables CORS
  // enforcement (not recommended in production).
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  maxBodyBytes: Number(process.env.MAX_BODY_BYTES) || 64 * 1024,
  rateLimit: {
    windowMs: Number(process.env.RATE_WINDOW_MS) || 60_000,
    maxRequests: Number(process.env.RATE_MAX_REQUESTS) || 120
  },
  // Timeout for upstream core calls (ms).
  coreTimeoutMs: Number(process.env.CORE_TIMEOUT_MS) || 10_000,
  // Bounded busy-retry for upstream responses carrying {"status":"busy"}
  // (the ledger-close lock). A busy response must NEVER be surfaced as a
  // definitive zero balance / missing account / failed submit — retry with
  // exponential backoff, then propagate an explicit 503.
  busyRetries: Number(process.env.CORE_BUSY_RETRIES) || 4,
  busyBaseDelayMs: Number(process.env.CORE_BUSY_DELAY_MS) || 150,
  // Read-only confirmation indexer. The upstream is fixed by configuration so a
  // request path can never select a different origin (no SSRF surface).
  indexer: {
    url: (process.env.NSAT_INDEXER_URL || 'http://127.0.0.1:8789').replace(/\/$/, ''),
    timeoutMs: Number(process.env.INDEXER_TIMEOUT_MS) || 5_000,
    maxStreams: Number(process.env.INDEXER_MAX_STREAMS) || 48,
    streamIdleMs: Number(process.env.INDEXER_STREAM_IDLE_MS) || 120_000,
    eventsRateMax: Number(process.env.INDEXER_EVENTS_RATE_MAX) || 60
  },
  // When set, confirmation and event routes refuse to answer unless the chain
  // itself reports exactly this identity. Empty = skip the comparison (local dev).
  expectedNetwork: (process.env.NSAT_EXPECTED_NETWORK || '').trim()
};

// --- logging (structured, secret-free) -------------------------------------
function log(level, event, fields = {}) {
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }) + '\n'
  );
}

// --- rate limiting (fixed window per IP) ------------------------------------
const rateBuckets = new Map();
function rateLimited(ip) {
  const { windowMs, maxRequests } = CONFIG.rateLimit;
  const now = Date.now();
  const bucket = rateBuckets.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }
  bucket.count += 1;
  rateBuckets.set(ip, bucket);
  if (rateBuckets.size > 10_000) {
    // bounded memory: drop expired buckets
    for (const [k, b] of rateBuckets) if (now > b.resetAt) rateBuckets.delete(k);
  }
  return bucket.count > maxRequests;
}

// --- helpers ----------------------------------------------------------------
// Hardening headers attached to EVERY response (JSON and proxied bodies).
// HSTS is meaningless over plain HTTP but harmless; browsers enforce it
// only on HTTPS responses, which is exactly the production deployment.
function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
    'Strict-Transport-Security': 'max-age=15552000; includeSubDomains',
    'Cache-Control': 'no-store'
  };
}

function sendJson(res, status, body, req) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...(req ? corsHeaders(req) : {}),
    ...securityHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin) return {};
  if (CONFIG.allowedOrigins.includes('*') || CONFIG.allowedOrigins.includes(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600'
    };
  }
  return {};
}

function coreFetch(path, { method = 'GET', body = null, contentType, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, CONFIG.coreHttpUrl);
    const req = http.request(
      url,
      { method, timeout: timeoutMs || CONFIG.coreTimeoutMs },
      (up) => {
        let data = '';
        up.setEncoding('utf8');
        up.on('data', (chunk) => {
          data += chunk;
          if (data.length > 1024 * 1024) {
            req.destroy();
            reject(new Error('upstream response too large'));
          }
        });
        up.on('end', () => resolve({ status: up.statusCode, body: data }));
      }
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('upstream timeout'));
    });
    req.on('error', reject);
    if (body !== null) {
      if (contentType) req.setHeader('Content-Type', contentType);
      req.write(body);
    }
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// GET a core path, retrying "busy" responses with bounded backoff.
// Never returns a body that looks like success while the ledger is busy.
async function coreFetchRead(path) {
  let delay = CONFIG.busyBaseDelayMs;
  for (let attempt = 0; attempt <= CONFIG.busyRetries; attempt += 1) {
    const up = await coreFetch(path);
    let parsed = null;
    try {
      parsed = JSON.parse(up.body);
    } catch {
      // opaque upstream body (HTML error page etc.) — not a busy marker
    }
    if (up.status === 200 && parsed && parsed.status === 'busy') {
      // core is mid ledger-close; this is NOT an authoritative answer
      if (attempt === CONFIG.busyRetries) {
        return { status: 503, body: JSON.stringify({ error: 'core ledger busy — try again shortly', status: 'busy' }) };
      }
      await sleep(delay);
      delay *= 2;
      continue;
    }
    if (up.status !== 200) {
      // propagate non-200 upstream verbatim (error sanitization happens at
      // the gateway route level by replacing the body below)
      return {
        status: up.status,
        body: JSON.stringify({ error: 'core node error', upstream_status: up.status })
      };
    }
    return { status: up.status, body: up.body };
  }
  // unreachable
  return { status: 503, body: JSON.stringify({ error: 'core ledger busy' }) };
}

// --- read-only confirmation indexer proxy -----------------------------------
// Two routes only, both GET, both read-only:
//   GET /v1/confirmations/{hash}
//   GET /v1/accounts/{G...}/events
// The chain identity is checked against the running core before either answers,
// so a misconfigured upstream can never return another network's verdict as if
// it belonged to this chain.
const TX_HASH_RE = /^[0-9a-f]{64}$/;
const EVENTS_PATH_RE = /^\/v1\/accounts\/(G[A-Z2-7]{55})\/events$/;
const EVENT_ROUTE_RE = /^\/v1\/accounts\/([^/]+)\/events$/;
const CONFIRMATION_PREFIX = '/v1/confirmations/';

let activeEventStreams = 0;
let identityCache = { at: 0, network: null };

async function chainNetworkIdentity() {
  if (identityCache.network && Date.now() - identityCache.at < 30_000) return identityCache.network;
  const up = await coreFetchRead('/info');
  if (up.status !== 200) throw new Error('core unavailable');
  let parsed;
  try {
    parsed = JSON.parse(up.body);
  } catch {
    throw new Error('core info malformed');
  }
  const network = parsed && parsed.info && typeof parsed.info.network === 'string' ? parsed.info.network : null;
  if (!network) throw new Error('chain identity missing');
  identityCache = { at: Date.now(), network };
  return network;
}

async function requireChainIdentity(res, req) {
  let network;
  try {
    network = await chainNetworkIdentity();
  } catch (err) {
    log('error', 'identity_check_failed', { error: err.message });
    sendJson(res, 503, { error: 'chain identity unavailable' }, req);
    return false;
  }
  if (CONFIG.expectedNetwork && network !== CONFIG.expectedNetwork) {
    log('error', 'chain_identity_mismatch', { expected: CONFIG.expectedNetwork, actual: network });
    sendJson(res, 503, { error: 'chain identity mismatch' }, req);
    return false;
  }
  return true;
}

function indexerConnect(path, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, CONFIG.indexer.url);
    const upstream = http.request(
      url,
      { method: 'GET', timeout: CONFIG.indexer.timeoutMs, headers: { Accept: 'application/json', ...extraHeaders } },
      (up) => resolve(up)
    );
    upstream.on('timeout', () => upstream.destroy(new Error('indexer timeout')));
    upstream.on('error', reject);
    upstream.end();
  });
}

async function indexerJson(path) {
  const up = await indexerConnect(path);
  let data = '';
  up.setEncoding('utf8');
  up.on('data', (c) => {
    data += c;
    if (data.length > 1024 * 1024) up.destroy();
  });
  await new Promise((resolve, reject) => {
    up.on('end', resolve);
    up.on('error', reject);
    up.on('close', resolve);
  });
  return { status: up.statusCode, body: data };
}

async function handleConfirmation(req, res, hash) {
  if (!TX_HASH_RE.test(hash)) {
    return sendJson(res, 400, { error: 'hash must be 64 lowercase hex characters' }, req);
  }
  if (!(await requireChainIdentity(res, req))) return;

  const query = new URL(req.url, 'http://x').searchParams.toString();
  const target = `${CONFIRMATION_PREFIX}${hash}${query ? `?${query}` : ''}`;
  try {
    const up = await indexerJson(target);
    if (up.status !== 200) {
      log('warn', 'indexer_confirmation_error', { upstream_status: up.status });
      return sendJson(res, 503, { error: 'confirmation index unavailable' }, req);
    }
    res.writeHead(200, {
      ...corsHeaders(req),
      ...securityHeaders(),
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(up.body)
    });
    res.end(up.body);
  } catch (err) {
    log('error', 'indexer_confirmation_failed', { error: err.message });
    sendJson(res, 503, { error: 'confirmation index unavailable' }, req);
  }
}

async function handleAccountEvents(req, res, account) {
  if (activeEventStreams >= CONFIG.indexer.maxStreams) {
    res.writeHead(503, { ...securityHeaders(), 'Retry-After': '5', 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'too many event streams' }));
  }
  if (!(await requireChainIdentity(res, req))) return;

  const query = new URL(req.url, 'http://x').searchParams.toString();
  // Resume cursor: the browser sends Last-Event-ID on reconnect; forward it so the
  // indexer replays from there instead of from the original `since`.
  const lastEventId = String(req.headers['last-event-id'] || '').trim();
  const headers = {};
  if (/^\d{1,12}$/.test(lastEventId)) headers['Last-Event-ID'] = lastEventId;

  activeEventStreams += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeEventStreams -= 1;
  };

  let upstream;
  try {
    upstream = await indexerConnect(`/v1/accounts/${account}/events${query ? `?${query}` : ''}`, headers);
  } catch (err) {
    release();
    log('error', 'indexer_events_failed', { error: err.message });
    return sendJson(res, 503, { error: 'event stream unavailable' }, req);
  }

  if (upstream.statusCode !== 200) {
    release();
    upstream.resume();
    log('warn', 'indexer_events_status', { upstream_status: upstream.statusCode });
    return sendJson(res, upstream.statusCode === 503 ? 503 : 502, { error: 'event stream unavailable' }, req);
  }

  res.writeHead(200, {
    ...corsHeaders(req),
    ...securityHeaders(),
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    // Disable reverse-proxy buffering; SSE must arrive event by event.
    'X-Accel-Buffering': 'no'
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  // An abandoned stream must free its slot promptly, not when the next event
  // happens to be written.
  res.setTimeout(CONFIG.indexer.streamIdleMs, () => {
    upstream.destroy();
    res.destroy();
  });
  upstream.on('data', (chunk) => res.write(chunk));
  upstream.on('end', () => {
    release();
    res.end();
  });
  upstream.on('error', () => {
    release();
    res.destroy();
  });
  res.on('close', () => {
    release();
    upstream.destroy();
  });
}

function handleIndexerRoute(req, res, pathname) {
  if (pathname.startsWith(CONFIRMATION_PREFIX)) {
    return handleConfirmation(req, res, pathname.slice(CONFIRMATION_PREFIX.length));
  }
  const match = EVENT_ROUTE_RE.exec(pathname);
  if (!match) return sendJson(res, 404, { error: 'not found' }, req);
  // Shape matches the endpoint but the account is not a valid G-strkey: answer
  // 400 rather than letting it look like a missing route.
  if (!EVENTS_PATH_RE.test(pathname)) {
    return sendJson(res, 400, { error: 'account must be a 56-character G strkey' }, req);
  }
  return handleAccountEvents(req, res, match[1]);
}

// --- read-only explorer snapshot -------------------------------------------
// The dashboard needs the node's own health/metrics picture in one round trip.
// Only the four read-only GETs below are touched (info, peers, quorum,
// metrics); none of them mutates the node. The result is cached briefly and
// served as `stale` if the node briefly stops answering, so a page refresh
// never turns into fabricated numbers: the client always sees how old the
// data is.
const EXPLORER_CACHE_MS = Number(process.env.EXPLORER_CACHE_MS) || 2500;
const EXPLORER_STALE_MS = 90_000;
// The core answers /info, /peers, /quorum and /metrics from the same loop that
// applies ledgers, so a read caught inside a multi-second close stalls and then
// returns in milliseconds once that close finishes. One timeout per endpoint
// therefore reports a value as unavailable for a reason that has nothing to do
// with the value: the reads are retried inside a single deadline instead, and
// only a node that stays silent for the whole deadline is called unavailable.
// The deadline stays below the dashboard's own 10 s request timeout.
const EXPLORER_DEADLINE_MS = Number(process.env.EXPLORER_DEADLINE_MS) || 8500;
const EXPLORER_ATTEMPT_MS = Number(process.env.EXPLORER_ATTEMPT_MS) || 2500;
const EXPLORER_RETRY_DELAY_MS = Number(process.env.EXPLORER_RETRY_DELAY_MS) || 120;
let explorerCache = null; // { at, payload }
let explorerInFlight = null;
// Closes this gateway personally witnessed. It outlives any single page visit,
// so a fresh tab can draw the last few real closes immediately instead of
// starting from an empty chart. `since` marks when the accumulation began.
const explorerHistory = { since: Date.now(), closes: [], samples: [], last: null };

async function coreFetchJson(path, timeoutMs) {
  const up = await coreFetch(path, { timeoutMs });
  if (up.status !== 200) throw new Error(`${path} -> ${up.status}`);
  return JSON.parse(up.body);
}

async function coreFetchJsonUntil(path, deadlineAt, attemptMs = EXPLORER_ATTEMPT_MS) {
  let lastError = null;
  while (Date.now() < deadlineAt) {
    const budget = deadlineAt - Date.now();
    try {
      return await coreFetchJson(path, Math.min(attemptMs, budget));
    } catch (err) {
      lastError = err;
      if (deadlineAt - Date.now() <= EXPLORER_RETRY_DELAY_MS + 250) break;
      await new Promise((resolve) => setTimeout(resolve, EXPLORER_RETRY_DELAY_MS));
    }
  }
  throw lastError || new Error(`${path} -> deadline exceeded`);
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function metricOf(metrics, name) {
  const m = metrics && metrics[name];
  return m && typeof m === 'object' ? m : null;
}

function pick(obj, keys) {
  if (!obj) return null;
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return Object.keys(out).length ? out : null;
}

async function readExplorerSnapshot() {
  const partial = [];
  const deadlineAt = Date.now() + EXPLORER_DEADLINE_MS;
  const [infoR, peersR, quorumR, metricsR] = await Promise.allSettled([
    coreFetchJsonUntil('/info', deadlineAt),
    coreFetchJsonUntil('/peers', deadlineAt),
    coreFetchJsonUntil('/quorum', deadlineAt),
    coreFetchJsonUntil('/metrics', deadlineAt)
  ]);

  if (infoR.status === 'rejected') {
    throw new Error(`core info unavailable: ${infoR.reason && infoR.reason.message}`);
  }
  const info = infoR.value && infoR.value.info ? infoR.value.info : null;
  if (!info) throw new Error('core info malformed');

  if (peersR.status === 'rejected') partial.push('peers');
  if (quorumR.status === 'rejected') partial.push('quorum');
  if (metricsR.status === 'rejected') partial.push('metrics');

  // Core reports 86400000 ms (its 24 h mLastPing default) for a peer ping
  // that never resolved; that is "not measured", not a real figure.
  const UNMEASURED_LATENCY_MS = 86400000;

  const peersDoc = peersR.status === 'fulfilled' ? peersR.value : null;
  const quorumDoc = quorumR.status === 'fulfilled' ? quorumR.value : null;
  const metricsDoc = metricsR.status === 'fulfilled' ? metricsR.value : null;
  const metrics = metricsDoc && metricsDoc.metrics ? metricsDoc.metrics : null;

  const ledger = info.ledger || {};
  const closeTime = num(ledger.closeTime);
  const qset = (info.quorum && info.quorum.qset) || {};

  // Peer list: ids and latencies are public chain topology; loopback
  // addresses are dropped so the gateway never leaks host layout.
  const peerRows = [];
  if (peersDoc) {
    for (const direction of ['inbound', 'outbound']) {
      const list = (peersDoc.authenticated_peers && peersDoc.authenticated_peers[direction]) || [];
      for (const p of list) {
        // Core reports 86400000 ms (24 h) as a sentinel when a peer ping
        // never resolved; surface that as "not measured" instead of a real
        // figure.
        const latencyMsRaw = num(p.latency);
        peerRows.push({
          id: String(p.id || '?'),
          direction,
          latencyMs:
            latencyMsRaw !== null && latencyMsRaw >= UNMEASURED_LATENCY_MS
              ? null
              : latencyMsRaw,
          elapsedSec: num(p.elapsed),
          version: p.ver ? String(p.ver) : null
        });
      }
    }
  }

  const agree = quorumDoc && quorumDoc.qset && Array.isArray(quorumDoc.qset.agree)
    ? quorumDoc.qset.agree.map(String)
    : [];
  const agreeCount = agree.length;
  const selfId = (quorumDoc && quorumDoc.node) || (info.quorum && info.quorum.node) || null;

  const validators = [];
  if (selfId) {
    validators.push({
      id: String(selfId), self: true, direction: 'self', agree: agree.length === 0 ? null : agree.includes(String(selfId)),
      latencyMs: null, elapsedSec: null, version: info.build ? String(info.build) : null
    });
  }
  for (const p of peerRows) {
    validators.push({
      ...p,
      self: false,
      agree: agree.length === 0 ? null : agree.includes(p.id)
    });
  }

  const closeMs = metricOf(metrics, 'ledger.ledger.close');
  const txPerLedger = metricOf(metrics, 'ledger.transaction.count');
  const scpCost = metricOf(metrics, 'scp.cost.per-slot');
  const connLatency = metricOf(metrics, 'overlay.connection.latency');
  const applyOk = metricOf(metrics, 'ledger.apply.success');
  const applyFail = metricOf(metrics, 'ledger.apply.failure');
  const pendingTx = metricOf(metrics, 'herder.pending-txs.count');

  // Accumulate what this gateway has actually seen, so the next visitor gets
  // real closes to draw instead of an empty chart.
  const ledgerNum = num(ledger.num);
  const txCum = txPerLedger ? num(txPerLedger.sum) : null;
  if (ledgerNum !== null && closeTime !== null) {
    const prev = explorerHistory.last;
    if (prev && ledgerNum > prev.num) {
      const span = ledgerNum - prev.num;
      const seconds = closeTime - prev.closeTime;
      if (seconds > 0 && seconds < 900) {
        let txs = null;
        let tps = null;
        if (txCum !== null && prev.tx !== null && txCum >= prev.tx) {
          txs = txCum - prev.tx;
          tps = Math.round((txs / seconds) * 100) / 100;
        }
        explorerHistory.closes.push({
          num: ledgerNum,
          closeTime,
          at: Date.now(),
          opened: span,
          seconds: Math.round((seconds / span) * 10) / 10,
          txs,
          tps,
          tx: txCum
        });
        if (explorerHistory.closes.length > 60) explorerHistory.closes.shift();
      }
    }
    explorerHistory.last = { num: ledgerNum, closeTime, tx: txCum };
  }
  explorerHistory.samples.push({
    at: Date.now(),
    latencyMs: connLatency ? num(connLatency.mean) : null,
    txPerLedger: txPerLedger ? num(txPerLedger.mean) : null,
    closeMs: closeMs ? num(closeMs.mean) : null,
    lagMs: num(qset.lag_ms),
    // One reading per KPI that draws a sparkline, so no chart ever plots a
    // different metric than the number next to it.
    num: ledgerNum,
    age: num(ledger.age),
    baseFee: num(ledger.baseFee),
    agree: agree.length || null,
    peers: num(info.peers && info.peers.authenticated_count)
  });
  if (explorerHistory.samples.length > 60) explorerHistory.samples.shift();

  return {
    ok: true,
    source: 'nsat-core',
    observedAt: Date.now(),
    partial,
    history: {
      since: explorerHistory.since,
      closes: explorerHistory.closes.slice(-40),
      samples: explorerHistory.samples.slice(-40)
    },
    network: typeof info.network === 'string' ? info.network : null,
    protocolVersion: num(info.protocol_version),
    build: info.build ? String(info.build) : null,
    state: info.state ? String(info.state) : null,
    startedOn: info.startedOn ? String(info.startedOn) : null,
    ledger: {
      num: num(ledger.num),
      hash: ledger.hash ? String(ledger.hash) : null,
      closeTime,
      age: num(ledger.age),
      baseFee: num(ledger.baseFee),
      baseReserve: num(ledger.baseReserve),
      maxTxSetSize: num(ledger.maxTxSetSize),
      version: num(ledger.version)
    },
    peers: {
      authenticated: num(info.peers && info.peers.authenticated_count),
      pending: num(info.peers && info.peers.pending_count)
    },
    quorum: {
      node: selfId ? String(selfId) : null,
      agreeCount: agree.length || null,
      validated: qset.validated === undefined ? null : Boolean(qset.validated),
      phase: qset.phase ? String(qset.phase) : null,
      lagMs: num(qset.lag_ms),
      ledger: num(qset.ledger),
      missing: num(qset.missing),
      delayed: num(qset.delayed),
      nodeCount: num(info.quorum && info.quorum.transitive && info.quorum.transitive.node_count)
    },
    validators,
    metrics: {
      closeMs: pick(closeMs, ['count', 'mean', 'median', '95%', 'max', '1_min_rate']),
      txPerLedger: pick(txPerLedger, ['count', 'mean', 'max', 'sum']),
      scpCost: pick(scpCost, ['count', 'mean', '95%', 'max']),
      connLatencyMs: pick(connLatency, ['count', 'mean', 'median', '95%', 'max']),
      applySuccess: applyOk ? num(applyOk.count) : null,
      applyFailure: applyFail ? num(applyFail.count) : null,
      // Cumulative counters (valid only as deltas between two readings).
      txAppliedTotal: txPerLedger ? num(txPerLedger.sum) : null,
      txSeenTotal: pendingTx ? num(pendingTx.count) : null
    }
  };
}

async function explorerSnapshot() {
  const now = Date.now();
  if (explorerCache && now - explorerCache.at < EXPLORER_CACHE_MS) return explorerCache.payload;
  if (explorerInFlight) return explorerInFlight;

  explorerInFlight = (async () => {
    try {
      const payload = await readExplorerSnapshot();
      explorerCache = { at: Date.now(), payload };
      return payload;
    } catch (err) {
      const age = explorerCache ? Date.now() - explorerCache.at : Infinity;
      if (explorerCache && age < EXPLORER_STALE_MS) {
        return { ...explorerCache.payload, stale: true, observedAt: explorerCache.at, error: err.message };
      }
      throw err;
    } finally {
      explorerInFlight = null;
    }
  })();
  return explorerInFlight;
}

// Signed-envelope validation. The gateway accepts base64-encoded XDR
// TransactionEnvelope blobs only — it never constructs or signs transactions.
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
function validateEnvelope(envelopeXdr) {
  if (typeof envelopeXdr !== 'string') return 'envelope_xdr must be a string';
  if (envelopeXdr.length === 0 || envelopeXdr.length > 8192)
    return 'envelope_xdr length out of range';
  if (!BASE64_RE.test(envelopeXdr)) return 'envelope_xdr is not valid base64';
  return null;
}

// Account IDs: ed25519 strkey, exactly 56 base32 chars, 'G' prefix.
const ACCOUNT_RE = /^G[A-Z2-7]{55}$/;
function validAccountId(acc) {
  return typeof acc === 'string' && ACCOUNT_RE.test(acc);
}

// --- routing (explicit allowlist; no wildcard proxying) ----------------------
const ROUTES = {
  'GET /health': async (req, res) => {
    sendJson(res, 200, {
      status: 'ok',
      service: 'satoshicore-api-gateway',
      version: process.env.GATEWAY_VERSION || '24.0.0',
      core: CONFIG.coreHttpUrl ? 'configured' : 'unset'
    });
  },

  // Read-only chain status, proxied from nsat-core /info with busy-retry.
  'GET /api/v1/chain/info': async (req, res) => {
    try {
      const up = await coreFetchRead('/info');
      res.writeHead(up.status, {
        ...corsHeaders(req),
        ...securityHeaders(),
        'Content-Type': 'application/json; charset=utf-8'
      });
      res.end(up.body);
    } catch (err) {
      log('error', 'core_info_failed', { error: err.message });
      sendJson(res, 502, { error: 'core node unreachable' });
    }
  },

  // Network / health status of the whole stack. The `network` field is the
  // TRUE on-chain identity read from the running nsat-core /info response —
  // NOT gateway configuration — so clients verify what the chain itself
  // reports. If core is unreachable or its response is malformed, network is
  // null and the client must fail closed.
  'GET /api/v1/network/status': async (req, res) => {
    try {
      const up = await coreFetchRead('/info');
      const coreReachable = up.status === 200;
      let network = null;
      let ledger = null;
      let serverTime = null;
      if (coreReachable) {
        try {
          const parsed = JSON.parse(up.body);
          network = (parsed && parsed.info && typeof parsed.info.network === 'string')
            ? parsed.info.network
            : null; // reachable but no usable identity string → client fails closed
          ledger = parsed && parsed.info && parsed.info.ledger
            ? parsed.info.ledger.num
            : null;
          // Core reports ledger close time, not a server clock. Expose the
          // authoritative closeTime so clients can detect stale ledgers.
          serverTime = parsed.info.ledger && parsed.info.ledger.closeTime
            || null;
        } catch {
          // non-JSON upstream — treat as degraded; identity unknown
        }
      }
      sendJson(res, 200, {
        gateway: 'ok',
        core: coreReachable ? 'ok' : 'unreachable',
        ledger,
        serverTime,
        network
      }, req);
    } catch (err) {
      log('error', 'network_status_failed', { error: err.message });
      sendJson(res, 200, { gateway: 'ok', core: 'unreachable', network: null }, req);
    }
  },

  // Read-only account query (balance / seqnum), proxied with busy-retry.
  // A busy frame is retried, NEVER answered as 'balance 0' or 'missing'.
  'GET /api/v1/account': async (req, res) => {
    const acc = new URL(req.url, 'http://x').searchParams.get('acc');
    if (!validAccountId(acc)) {
      return sendJson(res, 400, { error: 'acc must be a 56-char G-strkey' }, req);
    }
    try {
      const up = await coreFetchRead(`/account?acc=${encodeURIComponent(acc)}`);
      res.writeHead(up.status, {
        ...corsHeaders(req),
        ...securityHeaders(),
        'Content-Type': 'application/json; charset=utf-8'
      });
      res.end(up.body);
    } catch (err) {
      log('error', 'account_query_failed', { error: err.message });
      sendJson(res, 502, { error: 'core node unreachable' }, req);
    }
  },

  // One read-only snapshot of the running node for the explorer dashboard:
  // ledger head, peers, quorum agreement and the node's own metrics. Real
  // readings only — nothing is filled in when a source is missing.
  'GET /api/v1/explorer/snapshot': async (req, res) => {
    try {
      const snapshot = await explorerSnapshot();
      sendJson(res, 200, snapshot, req);
    } catch (err) {
      log('warn', 'explorer_snapshot_failed', { error: err.message });
      sendJson(res, 503, {
        ok: false,
        source: 'nsat-core',
        observedAt: Date.now(),
        error: 'core node unreachable'
      }, req);
    }
  },

  // Submit an already-signed transaction envelope to nsat-core.
  'POST /api/v1/tx': async (req, res, body) => {
    let parsed;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      return sendJson(res, 400, { error: 'invalid JSON body' });
    }
    const err = validateEnvelope(parsed && parsed.envelope_xdr);
    if (err) return sendJson(res, 400, { error: err });

    try {
      // stellar-core wire format: GET /tx?blob=<base64 envelope>
      const up = await coreFetch(`/tx?blob=${encodeURIComponent(parsed.envelope_xdr)}`);
      log('info', 'tx_submitted', { upstream_status: up.status });
      res.writeHead(up.status, {
        ...corsHeaders(req),
        ...securityHeaders(),
        'Content-Type': 'application/json; charset=utf-8'
      });
      res.end(up.body);
    } catch (err) {
      log('error', 'tx_submit_failed', { error: err.message });
      sendJson(res, 502, { error: 'core node unreachable' });
    }
  }
};

// --- server ------------------------------------------------------------------
function createServer() {
  return http.createServer((req, res) => {
    const ip = req.socket.remoteAddress || 'unknown';

    if (req.method === 'OPTIONS') {
      const headers = corsHeaders(req);
      if (!headers['Access-Control-Allow-Origin']) {
        res.writeHead(403);
        return res.end();
      }
      res.writeHead(204, headers);
      return res.end();
    }

    if (rateLimited(ip)) {
      log('warn', 'rate_limited', { ip });
      return sendJson(res, 429, { error: 'rate limit exceeded' });
    }

    const pathname = new URL(req.url, 'http://x').pathname;
    const isIndexerRoute = pathname.startsWith(CONFIRMATION_PREFIX) || EVENT_ROUTE_RE.test(pathname);
    if (isIndexerRoute) {
      if (req.method !== 'GET') {
        res.writeHead(405, { ...securityHeaders(), Allow: 'GET', 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'method not allowed' }));
      }
      return handleIndexerRoute(req, res, pathname);
    }

    const route = ROUTES[`${req.method} ${pathname}`];
    if (!route) {
      return sendJson(res, 404, { error: 'not found' });
    }

    if (req.method === 'POST') {
      let body = Buffer.alloc(0);
      let aborted = false;
      req.on('data', (chunk) => {
        if (aborted) return;
        body = Buffer.concat([body, chunk]);
        if (body.length > CONFIG.maxBodyBytes) {
          aborted = true;
          // Answer 413 and then drain the rest of the upload so the client
          // receives the response instead of a mid-write connection reset.
          if (req.pause) req.pause();
          sendJson(res, 413, { error: 'body too large' });
          res.on('finish', () => {
            req.resume();
            req.destroy();
          });
        }
      });
      req.on('end', () => {
        if (!aborted) route(req, res, body);
      });
      req.on('error', () => {});
    } else {
      route(req, res);
    }
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(CONFIG.port, CONFIG.bindHost, () => {
    log('info', 'gateway_listening', {
      port: CONFIG.port,
      host: CONFIG.bindHost || 'all-interfaces',
      core: CONFIG.coreHttpUrl,
      allowed_origins: CONFIG.allowedOrigins.length || 'none'
    });
  });
}

module.exports = { createServer, validateEnvelope, validAccountId, CONFIG };

