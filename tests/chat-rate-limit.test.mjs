// An open conversation must not be refused because the wallet already spent the
// API allowance, and a reconnect loop must not be able to open streams freely.
// This test starts the real gateway with the chat relay mounted and proves the
// per-class limits, including the Retry-After a client needs to back off.
//
// Each case starts its own gateway: the budgets are tiny on purpose, so sharing
// one process between cases would make the results depend on test order.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import nacl from 'tweetnacl';
import { requestString } from '../services/api-gateway/chat-relay.mjs';
import { encodeG } from '../lib/nsatCodec.js';

const root = path.resolve(import.meta.dirname, '..');
const unhex = (text) => new Uint8Array(Buffer.from(text, 'hex'));
const SEED = unhex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
const KEY = nacl.sign.keyPair.fromSeed(SEED);
const ADDRESS = encodeG(KEY.publicKey);

let nonceCounter = 0;

function signed({ method, requestPath, body }) {
  nonceCounter += 1;
  const nonce = `limit-nonce-${nonceCounter}-${Math.random().toString(36).slice(2, 10)}`;
  const ts = Date.now();
  const signature = nacl.sign.detached(
    Buffer.from(requestString({ method, path: requestPath, address: ADDRESS, ts, nonce })),
    KEY.secretKey,
  );
  return {
    headers: {
      'x-nsat-address': ADDRESS,
      'x-nsat-ts': String(ts),
      'x-nsat-nonce': nonce,
      'x-nsat-signature': Buffer.from(signature).toString('base64'),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  };
}

async function startGateway(env = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nsat-chat-limit-'));
  const port = 19000 + Math.floor(Math.random() * 800);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['services/api-gateway/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      NSAT_GATEWAY_HOST: '127.0.0.1',
      NSAT_CHAT_RELAY: '1',
      NSAT_CHAT_DB: path.join(dir, 'chat.sqlite'),
      ALLOWED_ORIGINS: '*',
      RATE_MAX_REQUESTS: '1000',
      RATE_CHAT_READ_MAX: '1000',
      RATE_CHAT_WRITE_MAX: '1000',
      RATE_CHAT_CONNECT_MAX: '1000',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  };
  for (let i = 0; i < 100; i += 1) {
    try {
      await fetch(`${base}/health`);
      return { base, stop };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  stop();
  throw new Error(`gateway did not start: ${child.stderr?.read()?.toString() || ''}`);
}

test('a 429 carries Retry-After and a retryAfter the client can read', async () => {
  const gateway = await startGateway({ RATE_CHAT_READ_MAX: '2' });
  try {
    const read = () => fetch(`${gateway.base}/api/v1/chat/messages`, {
      headers: signed({ method: 'GET', requestPath: '/api/v1/chat/messages' }).headers,
    });
    assert.equal((await read()).status, 200);
    assert.equal((await read()).status, 200);

    const third = await read();
    assert.equal(third.status, 429);
    const retryAfter = Number(third.headers.get('retry-after'));
    assert.ok(retryAfter >= 1, `Retry-After must be positive, got ${third.headers.get('retry-after')}`);
    const body = await third.json();
    assert.equal(body.error, 'rate limit exceeded');
    assert.equal(body.retryAfter, retryAfter);
  } finally {
    gateway.stop();
  }
});

test('a limited read budget does not close the door on sending', async () => {
  const gateway = await startGateway({ RATE_CHAT_READ_MAX: '1' });
  try {
    const read = () => fetch(`${gateway.base}/api/v1/chat/messages`, {
      headers: signed({ method: 'GET', requestPath: '/api/v1/chat/messages' }).headers,
    });
    assert.equal((await read()).status, 200);
    assert.equal((await read()).status, 429);

    const write = await fetch(`${gateway.base}/api/v1/chat/presence`, {
      method: 'POST',
      ...signed({ method: 'POST', requestPath: '/api/v1/chat/presence', body: { online: true } }),
    });
    assert.equal(write.status, 200, 'sending must keep working while reads are limited');
  } finally {
    gateway.stop();
  }
});

test('an exhausted API budget does not refuse chat reads', async () => {
  const gateway = await startGateway({ RATE_MAX_REQUESTS: '2' });
  try {
    const statuses = [];
    for (let i = 0; i < 3; i += 1) statuses.push((await fetch(`${gateway.base}/health`)).status);
    assert.ok(statuses.includes(429), `expected the API window to close, got ${statuses.join(',')}`);

    const read = await fetch(`${gateway.base}/api/v1/chat/keys?address=${ADDRESS}`);
    assert.notEqual(read.status, 429, 'chat must not inherit the API window');
  } finally {
    gateway.stop();
  }
});

test('the event stream has its own small budget so a reconnect loop is bounded', async () => {
  const gateway = await startGateway({ RATE_CHAT_CONNECT_MAX: '1' });
  try {
    const open = () => fetch(`${gateway.base}/api/v1/chat/events`, {
      headers: {
        ...signed({ method: 'GET', requestPath: '/api/v1/chat/events' }).headers,
        accept: 'text/event-stream',
      },
    });
    const first = await open();
    assert.equal(first.status, 200);
    await first.body?.cancel().catch(() => {});

    const second = await open();
    assert.equal(second.status, 429);
    assert.ok(Number(second.headers.get('retry-after')) >= 1);
    await second.body?.cancel().catch(() => {});
  } finally {
    gateway.stop();
  }
});
