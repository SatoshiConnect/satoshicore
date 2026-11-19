// Web Push for the chat relay: the queue, the privacy of its payload, and the
// two routes a device uses to register. The push service is stubbed, so these
// tests describe what the relay sends without any network.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import nacl from 'tweetnacl';
import * as webpush from 'web-push';
import {
  createChatRelay, requestString,
} from '../services/api-gateway/chat-relay.mjs';
import { createPushTransport, validPushSubscription } from '../services/api-gateway/push.mjs';
import { encodeG } from '../lib/nsatCodec.js';

const unhex = (text) => new Uint8Array(Buffer.from(text, 'hex'));
const SEED_A = unhex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
const SEED_B = unhex('1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100');
const KEY_A = nacl.sign.keyPair.fromSeed(SEED_A);
const KEY_B = nacl.sign.keyPair.fromSeed(SEED_B);
const ADDRESS_A = encodeG(KEY_A.publicKey);
const ADDRESS_B = encodeG(KEY_B.publicKey);

const SUBSCRIPTION = {
  endpoint: `https://push.example.test/send/${'a'.repeat(48)}`,
  keys: {
    p256dh: 'B'.repeat(87),
    auth: 'C'.repeat(22),
  },
};

let nonceCounter = 0;
function signed({ keyPair, address, method, path: requestPath, body = null }) {
  nonceCounter += 1;
  const nonce = `push-nonce-${nonceCounter}-${Math.random().toString(36).slice(2, 10)}`;
  const ts = Date.now();
  const signature = nacl.sign.detached(
    Buffer.from(requestString({ method, path: requestPath, address, ts, nonce })),
    keyPair.secretKey,
  );
  return {
    method,
    path: requestPath,
    headers: {
      'x-nsat-address': address,
      'x-nsat-ts': String(ts),
      'x-nsat-nonce': nonce,
      'x-nsat-signature': Buffer.from(signature).toString('base64'),
    },
    body,
  };
}

/** A relay with a recording push transport; `behaviour` decides each answer. */
function makeRelay({ configured = true, behaviour = () => ({ statusCode: 201 }) } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nsat-push-'));
  const sends = [];
  const push = configured
    ? createPushTransport({
      publicKey: 'test-public-key',
      privateKey: 'test-private-key',
      send: async (subscription, payload) => {
        sends.push({ subscription, payload, raw: payload });
        const answer = behaviour(sends.length);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    })
    : null;
  const relay = createChatRelay({ dbPath: path.join(dir, 'push.sqlite'), push });
  return {
    relay,
    sends,
    cleanup: () => {
      relay.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function register(relay, address = ADDRESS_B, subscription = SUBSCRIPTION) {
  return relay.handle(signed({
    keyPair: address === ADDRESS_B ? KEY_B : KEY_A,
    address,
    method: 'POST',
    path: '/api/v1/chat/push',
    body: { subscription },
  }));
}

let messageId = 0;
function sendMessage(relay, { from = ADDRESS_A, to = ADDRESS_B } = {}) {
  messageId += 1;
  return relay.handle(signed({
    keyPair: from === ADDRESS_A ? KEY_A : KEY_B,
    address: from,
    method: 'POST',
    path: '/api/v1/chat/messages',
    body: {
      envelope: { v: 1, from, to, nonce: 'n', ciphertext: 'sealed-text' },
      clientId: `push-client-${messageId}`,
    },
  }));
}

test('an unsigned or malformed registration is refused', () => {
  const { relay, cleanup } = makeRelay();
  try {
    const unsigned = relay.handle({ method: 'POST', path: '/api/v1/chat/push', headers: {}, body: {} });
    assert.equal(unsigned.status, 401);

    const bad = register(relay, ADDRESS_B, { endpoint: 'http://not-https/x', keys: {} });
    assert.equal(bad.status, 400);

    assert.equal(validPushSubscription(SUBSCRIPTION), true);
    assert.equal(validPushSubscription({ endpoint: 'http://push/x', keys: SUBSCRIPTION.keys }), false);
  } finally {
    cleanup();
  }
});

test('a registered device is woken once per burst, with a routing hint only', async () => {
  const { relay, sends, cleanup } = makeRelay();
  try {
    assert.equal(register(relay).status, 200);

    assert.equal(sendMessage(relay).status, 200);
    assert.equal(sendMessage(relay).status, 200);
    assert.equal(sendMessage(relay).status, 200);

    // Three messages, one pending row: the alert collapses, and the room it opens
    // is the newest sender.
    assert.equal(sends.length, 0, 'nothing is sent before a drain pass');
    const stats = await relay.pushTick();
    assert.equal(stats.delivered, 1);
    assert.equal(sends.length, 1);

    const payload = JSON.parse(sends[0].payload);
    assert.deepEqual(payload, { v: 1, peer: ADDRESS_A });
    assert.ok(!sends[0].payload.includes('sealed-text'), 'no ciphertext may cross the push service');
    assert.ok(!sends[0].payload.includes('sealed'), 'no message field may cross the push service');
    assert.equal(sends[0].subscription.endpoint, SUBSCRIPTION.endpoint);
    assert.equal(sends[0].subscription.keys.p256dh, SUBSCRIPTION.keys.p256dh);
  } finally {
    cleanup();
  }
});

test('a dead subscription is removed instead of retried forever', async () => {
  const gone = Object.assign(new Error('Subscription no longer valid'), { statusCode: 410 });
  const { relay, sends, cleanup } = makeRelay({ behaviour: () => { throw gone; } });
  try {
    register(relay);
    sendMessage(relay);
    const first = await relay.pushTick();
    assert.equal(first.delivered, 0);
    assert.equal(first.gone, 1);
    assert.equal(sends.length, 1);

    // The endpoint is gone, so the next message has nobody to wake and no
    // queue row is created at all.
    sendMessage(relay);
    const second = await relay.pushTick();
    assert.equal(second.due, 0);
    assert.equal(sends.length, 1, 'a removed subscription is never called again');
  } finally {
    cleanup();
  }
});

test('a push service error is retried with backoff, not dropped', async () => {
  const failing = Object.assign(new Error('push service unavailable'), { statusCode: 503 });
  const { relay, sends, cleanup } = makeRelay({ behaviour: () => { throw failing; } });
  try {
    register(relay);
    sendMessage(relay);

    const base = Date.now() + 1_000;
    const first = await relay.pushTick(base);
    assert.equal(first.retried, 1);
    assert.equal(first.delivered, 0);

    // Still inside the backoff window: nothing is attempted.
    const tooSoon = await relay.pushTick(base + 500);
    assert.equal(tooSoon.due, 0);

    // After the first backoff step the same alert is tried again.
    const later = await relay.pushTick(base + 30_000);
    assert.equal(later.due, 1);
    assert.equal(later.retried, 1);
    assert.equal(sends.length, 2);
  } finally {
    cleanup();
  }
});

test('a wallet is capped to a handful of device subscriptions, oldest evicted', async () => {
  const { relay, sends, cleanup } = makeRelay();
  try {
    const endpoints = [];
    for (let i = 0; i < 6; i += 1) {
      const subscription = {
        endpoint: `https://push.example.test/device/${i}/${'d'.repeat(40)}`,
        keys: SUBSCRIPTION.keys,
      };
      endpoints.push(subscription.endpoint);
      assert.equal(register(relay, ADDRESS_B, subscription).status, 200);
    }
    sendMessage(relay);
    const stats = await relay.pushTick();
    assert.equal(stats.delivered, 1);
    assert.equal(sends.length, 5, 'only the newest five devices are woken');
    assert.ok(!sends.some((send) => send.subscription.endpoint === endpoints[0]),
      'the oldest device lost its subscription');

    const removed = relay.handle(signed({
      keyPair: KEY_B,
      address: ADDRESS_B,
      method: 'POST',
      path: '/api/v1/chat/push/remove',
      body: { endpoint: endpoints[5] },
    }));
    assert.equal(removed.status, 200);
    assert.equal(removed.body.removed, 1);
  } finally {
    cleanup();
  }
});

test('turning alerts off stops the next burst immediately', async () => {
  const { relay, sends, cleanup } = makeRelay();
  try {
    register(relay);
    sendMessage(relay);
    sendMessage(relay);
    relay.handle(signed({
      keyPair: KEY_B,
      address: ADDRESS_B,
      method: 'POST',
      path: '/api/v1/chat/push/remove',
      body: { endpoint: SUBSCRIPTION.endpoint },
    }));

    const stats = await relay.pushTick();
    assert.equal(stats.dropped, 1);
    assert.equal(sends.length, 0, 'no alert for a wallet that opted out');
  } finally {
    cleanup();
  }
});

test('blocking clears an alert that is already queued', async () => {
  const { relay, sends, cleanup } = makeRelay();
  try {
    register(relay);
    sendMessage(relay);

    const blocked = relay.handle(signed({
      keyPair: KEY_A,
      address: ADDRESS_A,
      method: 'POST',
      path: '/api/v1/chat/blocks',
      body: { blocked: ADDRESS_B, action: 'add' },
    }));
    assert.equal(blocked.status, 200);

    const stats = await relay.pushTick();
    assert.equal(stats.due, 0, 'the queued wake-up is gone with the block');
    assert.equal(sends.length, 0);
  } finally {
    cleanup();
  }
});

test('without VAPID keys the relay answers 503 and never queues', async () => {
  const { relay, sends, cleanup } = makeRelay({ configured: false });
  try {
    assert.equal(register(relay).status, 503);
    assert.equal(relay.pushInfo().configured, false);
    assert.equal(sendMessage(relay).status, 200, 'messages still work without push');
    const stats = await relay.pushTick();
    assert.equal(stats.due, 0);
    assert.equal(sends.length, 0);
  } finally {
    cleanup();
  }
});

test('the running gateway exposes the push routes and rejects unsigned calls', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nsat-push-http-'));
  const port = 19100 + Math.floor(Math.random() * 400);
  const base = `http://127.0.0.1:${port}`;
  const { publicKey, privateKey } = webpush.generateVAPIDKeys();
  const child = spawn(process.execPath, ['services/api-gateway/server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      NSAT_GATEWAY_HOST: '127.0.0.1',
      NSAT_CHAT_RELAY: '1',
      NSAT_CHAT_DB: path.join(dir, 'chat.sqlite'),
      NSAT_VAPID_PUBLIC_KEY: publicKey,
      NSAT_VAPID_PRIVATE_KEY: privateKey,
      NSAT_PUSH_INTERVAL_MS: '0',
      ALLOWED_ORIGINS: '*',
      RATE_MAX_REQUESTS: '1000',
      RATE_CHAT_READ_MAX: '1000',
      RATE_CHAT_WRITE_MAX: '1000',
      RATE_CHAT_CONNECT_MAX: '1000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stop = () => {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  };

  try {
    let ready = false;
    for (let i = 0; i < 120 && !ready; i += 1) {
      try {
        ready = (await fetch(`${base}/health`)).ok;
      } catch { /* not up yet */ }
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(ready, 'gateway did not start');

    const unsigned = await fetch(`${base}/api/v1/chat/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subscription: SUBSCRIPTION }),
    });
    assert.equal(unsigned.status, 401);

    const request = signed({
      keyPair: KEY_A,
      address: ADDRESS_A,
      method: 'POST',
      path: '/api/v1/chat/push',
      body: { subscription: { endpoint: 'http://bad/x', keys: {} } },
    });
    const malformed = await fetch(`${base}/api/v1/chat/push`, {
      method: 'POST',
      headers: { ...request.headers, 'content-type': 'application/json' },
      body: JSON.stringify(request.body),
    });
    assert.equal(malformed.status, 400);

    const good = signed({
      keyPair: KEY_A,
      address: ADDRESS_A,
      method: 'POST',
      path: '/api/v1/chat/push',
      body: { subscription: SUBSCRIPTION },
    });
    const accepted = await fetch(`${base}/api/v1/chat/push`, {
      method: 'POST',
      headers: { ...good.headers, 'content-type': 'application/json' },
      body: JSON.stringify(good.body),
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { ok: true, subscriptions: 1 });
  } finally {
    stop();
  }
});
