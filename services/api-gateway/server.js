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
  coreTimeoutMs: Number(process.env.CORE_TIMEOUT_MS) || 10_000
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

  // Read-only chain status, proxied from nsat-core /info.
  'GET /api/v1/chain/info': async (req, res) => {
    try {
      const up = await coreFetch('/info');
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
        body = Buffer.concat([body, chunk]);
        if (body.length > CONFIG.maxBodyBytes) {
          aborted = true;
          req.destroy();
          sendJson(res, 413, { error: 'body too large' });
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
