// Two gateway findings that need no Firebase project or network:
//   F10 — the per-IP rate-limit map could grow without bound under a
//         spoofed-IP flood because it only pruned expired entries.
//   F11 — the chat failure log passed error.message through, which could
//         eventually carry input fragments into the log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  CONFIG,
  clientIp,
  rateLimited,
  rateLimitFor,
  chatRouteClass,
  RATE_BUCKET_LIMIT,
} = require('../services/api-gateway/server.js');

const { maxRequests, windowMs } = CONFIG.rateLimit;

test('the client IP is taken from Caddy only on a loopback connection', () => {
  const request = (remoteAddress, forwarded) => ({
    socket: { remoteAddress },
    headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded },
  });
  assert.equal(clientIp(request('127.0.0.1', '203.0.113.9')), '203.0.113.9');
  assert.equal(clientIp(request('::1', '198.51.100.4, 203.0.113.9')), '198.51.100.4');
  assert.equal(clientIp(request('127.0.0.1')), '127.0.0.1');
  assert.equal(clientIp(request('127.0.0.1', 'not-an-ip')), '127.0.0.1');
  // A remote client cannot choose another bucket by supplying the header.
  assert.equal(clientIp(request('203.0.113.5', '198.51.100.7')), '203.0.113.5');
});

test('the per-IP window allows exactly maxRequests and refuses the next one', () => {
  const buckets = new Map();
  const now = 1_000_000;
  for (let i = 0; i < maxRequests; i += 1) {
    assert.equal(rateLimited('203.0.113.7', now, buckets), false, `request ${i + 1} must be allowed`);
  }
  assert.equal(rateLimited('203.0.113.7', now, buckets), true);
});

test('a new window resets the counter for the same address', () => {
  const buckets = new Map();
  for (let i = 0; i < maxRequests; i += 1) rateLimited('203.0.113.8', 0, buckets);
  assert.equal(rateLimited('203.0.113.8', 0, buckets), true);
  assert.equal(rateLimited('203.0.113.8', windowMs + 1, buckets), false);
});

test('a spoofed-IP flood cannot grow the bucket map without bound', () => {
  const buckets = new Map();
  const now = 1_000_000;
  const total = RATE_BUCKET_LIMIT + 250;
  for (let i = 0; i < total; i += 1) {
    rateLimited(`198.51.100.${i}`, now, buckets);
  }
  assert.equal(buckets.size, RATE_BUCKET_LIMIT);
});

test('expired buckets are evicted before live ones when the map is full', () => {
  const buckets = new Map();
  for (let i = 0; i < RATE_BUCKET_LIMIT; i += 1) {
    rateLimited(`old-${i}`, 0, buckets);
  }
  rateLimited('new-address', windowMs + 1, buckets);
  assert.ok(buckets.size <= 2, `expired entries should be gone, got ${buckets.size}`);
});

test('each chat route is charged to sending, reading or connecting', () => {
  assert.equal(chatRouteClass('GET', '/api/v1/chat/messages'), 'read');
  assert.equal(chatRouteClass('POST', '/api/v1/chat/messages'), 'write');
  assert.equal(chatRouteClass('GET', '/api/v1/chat/tombstones'), 'read');
  assert.equal(chatRouteClass('GET', '/api/v1/chat/blocks'), 'read');
  assert.equal(chatRouteClass('POST', '/api/v1/chat/blocks'), 'write');
  assert.equal(chatRouteClass('GET', '/api/v1/chat/presence'), 'read');
  assert.equal(chatRouteClass('POST', '/api/v1/chat/presence'), 'write');
  assert.equal(chatRouteClass('POST', '/api/v1/chat/ack'), 'write');
  assert.equal(chatRouteClass('GET', '/api/v1/chat/events'), 'connect');
});

test('an exhausted API window leaves every chat class available', () => {
  const now = 2_000_000;
  const ip = '198.51.100.200';
  for (let i = 0; i < CONFIG.rateLimit.maxRequests; i += 1) rateLimitFor('api', ip, now);
  const api = rateLimitFor('api', ip, now);
  assert.equal(api.limited, true);
  assert.ok(api.retryAfterMs > 0, 'a refusal must say how long to wait');

  for (const limitClass of ['read', 'write', 'connect']) {
    assert.equal(rateLimitFor(limitClass, ip, now).limited, false,
      `${limitClass} must keep its own budget instead of inheriting the API one`);
  }
});

test('an exhausted chat read budget leaves sending and the API available', () => {
  const now = 3_000_000;
  const ip = '198.51.100.201';
  const { chat } = CONFIG.rateLimit;
  for (let i = 0; i < chat.read.maxRequests; i += 1) rateLimitFor('read', ip, now);
  assert.equal(rateLimitFor('read', ip, now).limited, true);
  assert.equal(rateLimitFor('write', ip, now).limited, false, 'sending must survive a slow reader');
  assert.equal(rateLimitFor('connect', ip, now).limited, false);
  assert.equal(rateLimitFor('api', ip, now).limited, false);
});

test('the chat write budget is at most the API budget, never above it', () => {
  // The split must not raise the ceiling on the one class that stores mail.
  assert.ok(CONFIG.rateLimit.chat.write.maxRequests <= CONFIG.rateLimit.maxRequests,
    'sending must not get a larger transport allowance than the API had');
});

test('the chat failure log records a stable code, never an error message', () => {
  const source = readFileSync(
    new URL('../services/api-gateway/server.js', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /chat_relay_failed'\s*,\s*\{\s*message\s*:/,
    'an error message can contain input fragments and must not be logged',
  );
  assert.match(
    source,
    /chat_relay_failed'\s*,\s*\{\s*code\s*:/,
    'a stable error code should be logged instead',
  );
});
