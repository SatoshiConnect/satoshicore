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
const net = require('node:net');
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
  // Transport limits, counted per client IP and per route class. The wallet's
  // chain reads and the chat relay have different request shapes, so they no
  // longer share one bucket: an open chat must not spend the wallet's
  // allowance, and a burst of chain polling must not close a conversation.
  // Messaging abuse stays bounded by the relay's signed-request checks, the
  // per-sender daily quota, the mailbox ceiling and the block list.
  rateLimit: {
    windowMs: Number(process.env.RATE_WINDOW_MS) || 60_000,
    maxRequests: Number(process.env.RATE_MAX_REQUESTS) || 120,
    chat: {
      // Mailbox reads, tombstones, receipts, presence reads, block reads.
      read: {
        windowMs: Number(process.env.RATE_CHAT_READ_WINDOW_MS) || 60_000,
        maxRequests: Number(process.env.RATE_CHAT_READ_MAX) || 300
      },
      // Sends, acks, deletes, typing, presence beats and block edits.
      write: {
        windowMs: Number(process.env.RATE_CHAT_WRITE_WINDOW_MS) || 60_000,
        maxRequests: Number(process.env.RATE_CHAT_WRITE_MAX) || 120
      },
      // Event-stream handshakes: a reconnect loop must not open a stream a second.
      connect: {
        windowMs: Number(process.env.RATE_CHAT_CONNECT_WINDOW_MS) || 60_000,
        maxRequests: Number(process.env.RATE_CHAT_CONNECT_MAX) || 30
      }
    }
  },
  // Timeout for upstream core calls (ms).
  coreTimeoutMs: Number(process.env.CORE_TIMEOUT_MS) || 10_000,
  // Bounded busy-retry for upstream responses carrying {"status":"busy"}
  // (the ledger-close lock). A busy response must NEVER be surfaced as a
  // definitive zero balance / missing account / failed submit — retry with
  // exponential backoff, then propagate an explicit 503.
  busyRetries: Number(process.env.CORE_BUSY_RETRIES) || 4,
  busyBaseDelayMs: Number(process.env.CORE_BUSY_DELAY_MS) || 150,
  // Account accessibility (Core protocol 30 reserve sponsorship). The
  // gateway holds NO keys: it publishes the policy the wallet gates on and
  // relays already-signed envelopes like any other transaction. Sponsorship
  // itself is executed by an operator-held sponsor account
  // (services/sponsor/sponsor-open.js).
  sponsorship: {
    enabled: process.env.NSAT_SPONSORSHIP_ENABLED === '1',
    requiredProtocol: 30,
    reserveUnits: 2
  },

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

// --- client address ---------------------------------------------------------
// Caddy is the only public listener and reaches this process over loopback.
// Without reading its X-Forwarded-For, every browser shares 127.0.0.1 and one
// 120 req/min bucket, so a handful of tabs can lock the whole site out with
// 429s. Trust the header only from a loopback peer; a direct remote request
// cannot spoof its bucket.
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function clientIp(req) {
  const remote = String(req.socket?.remoteAddress || 'unknown');
  if (!LOOPBACK_ADDRESSES.has(remote)) return remote;
  const forwarded = String(req.headers?.['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  return net.isIP(forwarded) ? forwarded : remote;
}

// --- rate limiting (fixed window per client IP, per route class) -------------
// A spoofed-IP flood must not grow a map without bound. Once the limit is
// reached, expired buckets go first, then the oldest insertion-order entries;
// an evicted IP simply starts a fresh window.
const RATE_BUCKET_LIMIT = 10_000;

/** One bounded fixed-window counter. Returns the verdict and the wait left. */
function countRequest(buckets, ip, now, windowMs, maxRequests) {
  const bucket = buckets.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }
  bucket.count += 1;
  buckets.set(ip, bucket);
  if (buckets.size > RATE_BUCKET_LIMIT) {
    for (const [key, entry] of buckets) {
      if (now > entry.resetAt) buckets.delete(key);
    }
    for (const key of buckets.keys()) {
      if (buckets.size <= RATE_BUCKET_LIMIT) break;
      buckets.delete(key);
    }
  }
  return {
    limited: bucket.count > maxRequests,
    retryAfterMs: Math.max(0, bucket.resetAt - now)
  };
}

const rateBuckets = new Map();
const rateChatBuckets = { read: new Map(), write: new Map(), connect: new Map() };

/** Wallet/API calls keep exactly the previous single-window behaviour. */
function rateLimited(ip, now = Date.now(), buckets = rateBuckets) {
  const { windowMs, maxRequests } = CONFIG.rateLimit;
  return countRequest(buckets, ip, now, windowMs, maxRequests).limited;
}

/**
 * Which limit a chat path is charged to. Sending, reading history and opening
 * the event stream have separate budgets on purpose: a hundred polls must never
 * block a message, and a reconnect storm must never close a room.
 */
const CHAT_READ_PATHS = new Set([
  '/api/v1/chat/messages',
  '/api/v1/chat/tombstones',
  '/api/v1/chat/read',
  '/api/v1/chat/presence',
  '/api/v1/chat/blocks',
  '/api/v1/chat/keys'
]);
function chatRouteClass(method, pathname) {
  if (pathname === '/api/v1/chat/events') return 'connect';
  if (String(method).toUpperCase() === 'GET' && CHAT_READ_PATHS.has(pathname)) return 'read';
  return 'write';
}

/** The limit for one request; `api` covers everything outside the relay. */
function rateLimitFor(limitClass, ip, now = Date.now()) {
  if (limitClass === 'api') {
    const { windowMs, maxRequests } = CONFIG.rateLimit;
    return countRequest(rateBuckets, ip, now, windowMs, maxRequests);
  }
  const config = CONFIG.rateLimit.chat[limitClass];
  return countRequest(rateChatBuckets[limitClass], ip, now, config.windowMs, config.maxRequests);
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

function sendJson(res, status, body, req, extraHeaders = null) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...(req ? corsHeaders(req) : {}),
    ...securityHeaders(),
    ...(extraHeaders || {}),
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
      'Access-Control-Allow-Headers': 'Content-Type, X-NSAT-Address, X-NSAT-Device, X-NSAT-Chat-Pub, X-NSAT-Chat-Delegation, X-NSAT-Ts, X-NSAT-Nonce, X-NSAT-Signature',
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

// --- read-only indexer proxy ------------------------------------------------
// GET only, read-only, and every answer is gated on the chain identity:
//   GET /v1/confirmations/{hash}
//   GET /v1/accounts/{G...}/events          (SSE, streamed)
//   GET /v1/accounts/{G...}/transactions    (wallet history)
//   GET /v1/tx/{hash}                       (wallet detail)
//   GET /v1/health                          (index freshness)
// The same-origin wallet points its indexer base URL at this gateway, so these
// five are the whole read surface it can reach. The identity is checked against
// the running core before any of them answers, so a misconfigured upstream can
// never return another network's verdict as if it belonged to this chain.
const TX_HASH_RE = /^[0-9a-f]{64}$/;
const EVENTS_PATH_RE = /^\/v1\/accounts\/(G[A-Z2-7]{55})\/events$/;
const EVENT_ROUTE_RE = /^\/v1\/accounts\/([^/]+)\/events$/;
const TX_DETAIL_RE = /^\/v1\/tx\/([^/]+)$/;
const ACCOUNT_TX_RE = /^\/v1\/accounts\/([^/]+)\/transactions$/;
const CONFIRMATION_PREFIX = '/v1/confirmations/';
const MAX_HISTORY_LIMIT = 200;
// A history page cursor: `ledger:opIndex:txHash`, as issued by the indexer.
// Validated here so a malformed value is a 400 instead of reaching the index
// and coming back as a confusing empty page.
const HISTORY_CURSOR_RE = /^\d{1,12}:\d{1,6}:[0-9a-f]{64}$/;

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

// A plain read that the indexer already validates: pass its body through and
// keep its 404 so the wallet can tell "no such transaction" from "index down".
async function handleIndexerRead(req, res, target) {
  if (!(await requireChainIdentity(res, req))) return;
  try {
    const up = await indexerJson(target);
    if (up.status !== 200 && up.status !== 404) {
      log('warn', 'indexer_read_error', { upstream_status: up.status });
      return sendJson(res, 503, { error: 'indexer unavailable' }, req);
    }
    res.writeHead(up.status, {
      ...corsHeaders(req),
      ...securityHeaders(),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(up.body)
    });
    res.end(up.body);
  } catch (err) {
    log('error', 'indexer_read_failed', { error: err.message });
    sendJson(res, 503, { error: 'indexer unavailable' }, req);
  }
}

function handleIndexerRoute(req, res, pathname) {
  if (pathname.startsWith(CONFIRMATION_PREFIX)) {
    return handleConfirmation(req, res, pathname.slice(CONFIRMATION_PREFIX.length));
  }
  if (pathname === '/v1/health') {
    return handleIndexerRead(req, res, '/v1/health');
  }
  if (pathname === '/v1/mint') {
    return handleIndexerRead(req, res, '/v1/mint');
  }
  const txDetail = TX_DETAIL_RE.exec(pathname);
  if (txDetail) {
    if (!TX_HASH_RE.test(txDetail[1])) {
      return sendJson(res, 400, { error: 'hash must be 64 lowercase hex characters' }, req);
    }
    return handleIndexerRead(req, res, `/v1/tx/${txDetail[1]}`);
  }
  const accountTx = ACCOUNT_TX_RE.exec(pathname);
  if (accountTx) {
    if (!/^G[A-Z2-7]{55}$/.test(accountTx[1])) {
      return sendJson(res, 400, { error: 'account must be a 56-character G strkey' }, req);
    }
    // Bound the page size here rather than trusting the caller: the indexer's
    // own limit is honoured but never allowed to grow the response without end.
    const params = new URL(req.url, 'http://x').searchParams;
    const raw = params.get('limit');
    const parsed = Number.parseInt(raw ?? '', 10);
    const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_HISTORY_LIMIT) : 50;
    const before = params.get('before');
    if (before !== null && !HISTORY_CURSOR_RE.test(before)) {
      return sendJson(res, 400, { error: 'before must be ledger:opIndex:txHash' }, req);
    }
    const query = before === null
      ? `?limit=${limit}`
      : `?limit=${limit}&before=${before}`;
    return handleIndexerRead(req, res, `/v1/accounts/${accountTx[1]}/transactions${query}`);
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

  // Sponsorship policy: what the wallet needs to decide whether the flow is
  // offerable on THIS network, and how much reserve a sponsor locks. Read
  // from the live core /info, never hard-coded, so a node on protocol 29
  // reports 29 and the wallet keeps the flow closed.
  'GET /api/v1/sponsorship/policy': async (req, res) => {
    try {
      const up = await coreFetchRead('/info');
      if (up.status !== 200) {
        return sendJson(res, 503, { error: 'core node unavailable' }, req);
      }
      let info = null;
      try {
        info = JSON.parse(up.body).info || null;
      } catch {
        return sendJson(res, 503, { error: 'core info malformed' }, req);
      }
      const protocolVersion = Number(info && info.protocol_version);
      const baseReserve = Number(info && info.ledger && info.ledger.baseReserve);
      const hasProtocol = Number.isSafeInteger(protocolVersion) && protocolVersion > 0;
      const hasReserve = Number.isSafeInteger(baseReserve) && baseReserve > 0;
      sendJson(res, 200, {
        enabled: CONFIG.sponsorship.enabled,
        requiredProtocol: CONFIG.sponsorship.requiredProtocol,
        protocolVersion: hasProtocol ? protocolVersion : null,
        baseReserve: hasReserve ? baseReserve : null,
        // Exact integer as a decimal string: reserves are treasury-scale.
        reservePerAccount: hasReserve
          ? String(BigInt(baseReserve) * BigInt(CONFIG.sponsorship.reserveUnits))
          : null,
        // The flow is only offerable when the deployment opted in AND the
        // ledger itself has reached the protocol that supports it.
        available: Boolean(
          CONFIG.sponsorship.enabled && hasProtocol &&
          protocolVersion >= CONFIG.sponsorship.requiredProtocol
        )
      }, req);
    } catch (err) {
      log('error', 'sponsorship_policy_failed', { error: err.message });
      sendJson(res, 502, { error: 'core node unreachable' }, req);
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

// --- encrypted chat relay (opt-in) -------------------------------------------
// Off unless NSAT_CHAT_RELAY=1. Enabling it adds endpoints and a SQLite file,
// which is an operator decision, not something a deploy turns on by accident
// (docs/E2E-CHAT-DESIGN.md). The relay stores ciphertext only; the request
// signature (wallet key) is the identity it checks.
const CHAT_PREFIX = '/api/v1/chat/';
const CHAT_ENABLED = process.env.NSAT_CHAT_RELAY === '1';
// Web Push (chat wake-ups while the app is closed) is opt-in at the operator
// level too: without a VAPID keypair the relay simply does not queue alerts and
// the UI hides the control. The private key never leaves this process.
const PUSH_CONFIG = {
  publicKey: String(process.env.NSAT_VAPID_PUBLIC_KEY || '').trim(),
  privateKey: String(process.env.NSAT_VAPID_PRIVATE_KEY || '').trim(),
  subject: String(process.env.NSAT_VAPID_SUBJECT || '').trim() || undefined,
  // 0 disables the drain timer (tests that only inspect the queue use this).
  intervalMs: Number(process.env.NSAT_PUSH_INTERVAL_MS) >= 0
    ? Number(process.env.NSAT_PUSH_INTERVAL_MS)
    : 2_500
};
let chatRelayPromise = null;
let pushDrainTimer = null;

function chatRelay() {
  if (!chatRelayPromise) {
    const dbPath = process.env.NSAT_CHAT_DB
      || require('node:path').join(__dirname, 'data', 'chat.sqlite');
    require('node:fs').mkdirSync(require('node:path').dirname(dbPath), { recursive: true });
    // Operator-tunable safety valves: a mailbox ceiling that can be raised for a
    // busy relay, and how often expired mail is collected. Both have documented
    // defaults in chat-relay.mjs.
    const maxPerRecipient = Number(process.env.NSAT_CHAT_MAX_PENDING) || undefined;
    const gcIntervalMs = Number(process.env.NSAT_CHAT_GC_MS) || undefined;
    chatRelayPromise = Promise.all([import('./chat-relay.mjs'), import('./push.mjs')])
      .then(([{ createChatRelay }, { createPushTransport }]) => {
        const push = createPushTransport(PUSH_CONFIG);
        const relay = createChatRelay({ dbPath, maxPerRecipient, gcIntervalMs, push });
        // One drain pass at a time; `pushTick` claims rows so an overlapping
        // timer cannot deliver the same alert twice.
        if (push.configured && PUSH_CONFIG.intervalMs > 0 && !pushDrainTimer) {
          pushDrainTimer = setInterval(() => {
            relay.pushTick().catch(() => {});
          }, PUSH_CONFIG.intervalMs);
          if (typeof pushDrainTimer.unref === 'function') pushDrainTimer.unref();
        }
        return relay;
      })
      .catch((error) => {
        chatRelayPromise = null;
        throw error;
      });
  }
  return chatRelayPromise;
}

function handleChatRequest(req, res, pathname, searchParams) {
  let body = Buffer.alloc(0);
  let aborted = false;
  req.on('data', (chunk) => {
    if (aborted) return;
    body = Buffer.concat([body, chunk]);
    if (body.length > 16 * 1024) {
      aborted = true;
      if (req.pause) req.pause();
      sendJson(res, 413, { error: 'body too large' }, req);
      res.on('finish', () => { req.resume(); req.destroy(); });
    }
  });
  req.on('error', () => {});
  req.on('end', async () => {
    if (aborted) return;
    let parsed = null;
    try { parsed = body.length ? JSON.parse(body.toString('utf8')) : null; } catch { parsed = null; }
    try {
      const relay = await chatRelay();
      const result = relay.handle({
        method: req.method,
        path: pathname,
        query: Object.fromEntries(searchParams.entries()),
        headers: req.headers,
        body: parsed,
      });
      return sendJson(res, result.status, result.body, req);
    } catch (error) {
      // A stable code only. An error message can carry input fragments, and a
      // private message must never reach the log through a failure path.
      log('error', 'chat_relay_failed', { code: String(error?.code || error?.name || 'unknown') });
      return sendJson(res, 500, { error: 'chat relay unavailable' }, req);
    }
  });
}

async function handleChatEvents(req, res, pathname) {
  let relay;
  try {
    relay = await chatRelay();
  } catch {
    return sendJson(res, 503, { error: 'chat relay unavailable' }, req);
  }
  const auth = relay.authenticate({ method: req.method, path: pathname, headers: req.headers });
  if (!auth) return sendJson(res, 401, { error: 'unauthorized' }, req);

  res.writeHead(200, {
    ...corsHeaders(req),
    ...securityHeaders(),
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 3000\n\n');
  res.write('event: ready\ndata: {}\n\n');

  const unsubscribe = relay.subscribe((event) => {
    if (event.recipient !== auth.address) return;
    const { recipient, ...payload } = event;
    res.write(`event: ${payload.type || 'message'}\ndata: ${JSON.stringify(payload)}\n\n`);
  });
  // A comment keeps the connection alive through proxies without inventing an
  // application event. It contains no address, message id or ciphertext.
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* closed */ }
  }, 25_000);
  const cleanup = () => {
    clearInterval(ping);
    unsubscribe();
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
}

// --- server ------------------------------------------------------------------
function createServer() {
  return http.createServer((req, res) => {
    const ip = clientIp(req);

    if (req.method === 'OPTIONS') {
      const headers = corsHeaders(req);
      if (!headers['Access-Control-Allow-Origin']) {
        res.writeHead(403);
        return res.end();
      }
      res.writeHead(204, headers);
      return res.end();
    }

    const url = new URL(req.url, 'http://x');
    const pathname = url.pathname;
    // Chat is charged to its own class, so opening a conversation cannot be
    // refused because wallet polling already used the API allowance.
    const limitClass = CHAT_ENABLED && pathname.startsWith(CHAT_PREFIX)
      ? chatRouteClass(req.method, pathname)
      : 'api';
    const limit = rateLimitFor(limitClass, ip);
    if (limit.limited) {
      const retryAfter = Math.max(1, Math.ceil(limit.retryAfterMs / 1000));
      log('warn', 'rate_limited', { ip, class: limitClass, retry_after: retryAfter });
      return sendJson(
        res, 429,
        { error: 'rate limit exceeded', retryAfter },
        req,
        { 'Retry-After': String(retryAfter) }
      );
    }
    if (CHAT_ENABLED && pathname === '/api/v1/chat/events') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' }, req);
      return handleChatEvents(req, res, pathname);
    }
    if (CHAT_ENABLED && pathname.startsWith(CHAT_PREFIX)) {
      return handleChatRequest(req, res, pathname, url.searchParams);
    }
    const isIndexerRoute =
      pathname.startsWith(CONFIRMATION_PREFIX) ||
      pathname === '/v1/health' ||
      pathname === '/v1/mint' ||
      EVENT_ROUTE_RE.test(pathname) ||
      TX_DETAIL_RE.test(pathname) ||
      ACCOUNT_TX_RE.test(pathname);
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

module.exports = {
  createServer,
  validateEnvelope,
  validAccountId,
  CONFIG,
  // Exported for the bounded-memory and proxy-address tests; not a public HTTP surface.
  clientIp,
  rateLimited,
  rateLimitFor,
  chatRouteClass,
  RATE_BUCKET_LIMIT,
};

