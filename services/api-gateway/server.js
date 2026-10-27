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
  busyBaseDelayMs: Number(process.env.CORE_BUSY_DELAY_MS) || 150
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
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store'
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

function coreFetch(path, { method = 'GET', body = null, contentType } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, CONFIG.coreHttpUrl);
    const req = http.request(
      url,
      { method, timeout: CONFIG.coreTimeoutMs },
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
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(up.body);
    } catch (err) {
      log('error', 'core_info_failed', { error: err.message });
      sendJson(res, 502, { error: 'core node unreachable' });
    }
  },

  // Network / health status of the whole stack. Companion endpoint for the
  // status page: verifies the gateway itself and liveness of the core node.
  'GET /api/v1/network/status': async (req, res) => {
    try {
      const up = await coreFetchRead('/info');
      const coreReachable = up.status === 200;
      let serverTime = null;
      let ledger = null;
      if (coreReachable) {
        try {
          const parsed = JSON.parse(up.body);
          ledger = parsed && parsed.info && parsed.info.ledger ? parsed.info.ledger.num : null;
          serverTime = parsed && parsed.info ? parsed.info.serverTime || null : null;
        } catch {
          // non-JSON upstream — treat as degraded
        }
      }
      sendJson(res, coreReachable ? 200 : 200, {
        gateway: 'ok',
        core: coreReachable ? 'ok' : 'unreachable',
        ledger,
        serverTime,
        network: process.env.NSAT_NETWORK_NAME || 'NSAT'
      });
    } catch (err) {
      log('error', 'network_status_failed', { error: err.message });
      sendJson(res, 200, { gateway: 'ok', core: 'unreachable' });
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
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
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

    const route = ROUTES[`${req.method} ${req.pathname ?? new URL(req.url, 'http://x').pathname}`];
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
  server.listen(CONFIG.port, () => {
    log('info', 'gateway_listening', {
      port: CONFIG.port,
      core: CONFIG.coreHttpUrl,
      allowed_origins: CONFIG.allowedOrigins.length || 'none'
    });
  });
}

module.exports = { createServer, validateEnvelope, CONFIG };
