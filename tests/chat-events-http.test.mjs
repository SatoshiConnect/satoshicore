// The relay's unit tests exercise the event bus, but the gateway route is what
// a browser actually opens. This test starts the real server on a loopback port,
// authenticates an SSE handshake with a wallet signature, and proves a message
// wakes only that connection.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import nacl from 'tweetnacl';
import {
  chatIdentityRequestString, requestString, verifySignedRequest,
} from '../services/api-gateway/chat-relay.mjs';
import { signChatDelegation, sealMessage, x25519KeyPairFromSeed } from '../lib/e2eChat.js';
import { encodeG } from '../lib/nsatCodec.js';

const root = path.resolve(import.meta.dirname, '..');
const unhex = (text) => new Uint8Array(Buffer.from(text, 'hex'));
const SEED_A = unhex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
const SEED_B = unhex('1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100');
const KEY_A = nacl.sign.keyPair.fromSeed(SEED_A);
const KEY_B = nacl.sign.keyPair.fromSeed(SEED_B);
const ADDRESS_A = encodeG(KEY_A.publicKey);
const ADDRESS_B = encodeG(KEY_B.publicKey);

let dir;
let child;
let base;
let nonceCounter = 0;

function signed({ keyPair, address, method, requestPath, body, device = '' }) {
  nonceCounter += 1;
  const nonce = `http-nonce-${nonceCounter}-${Math.random().toString(36).slice(2, 10)}`;
  const ts = Date.now();
  const signature = nacl.sign.detached(
    Buffer.from(requestString({ method, path: requestPath, address, ts, nonce, device })),
    keyPair.secretKey,
  );
  return {
    headers: {
      'x-nsat-address': address,
      ...(device ? { 'x-nsat-device': device } : {}),
      'x-nsat-ts': String(ts),
      'x-nsat-nonce': nonce,
      'x-nsat-signature': Buffer.from(signature).toString('base64'),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  };
}

async function waitForServer() {
  for (let i = 0; i < 80; i += 1) {
    try {
      await fetch(`${base}/api/v1/chat/keys?address=${ADDRESS_A}`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`gateway did not start: ${child?.stderr?.read()?.toString() || ''}`);
}

async function readUntil(reader, state, needle, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!state.text.includes(needle)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`timed out waiting for ${needle}: ${state.text}`);
    const result = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${needle}`)), remaining)),
    ]);
    if (result.done) throw new Error(`stream closed before ${needle}: ${state.text}`);
    state.text += new TextDecoder().decode(result.value, { stream: true });
  }
}

before(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'nsat-chat-http-'));
  const port = 18000 + Math.floor(Math.random() * 1000);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['services/api-gateway/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      NSAT_GATEWAY_HOST: '127.0.0.1',
      NSAT_CHAT_RELAY: '1',
      NSAT_CHAT_DB: path.join(dir, 'chat.sqlite'),
      ALLOWED_ORIGINS: '*',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer();
});

after(() => {
  child?.kill();
  rmSync(dir, { recursive: true, force: true });
});

test('the SSE route rejects an unsigned handshake and wakes the signed recipient', async () => {
  const refused = await fetch(`${base}/api/v1/chat/events`);
  assert.equal(refused.status, 401);

  const handshake = signed({
    keyPair: KEY_B, address: ADDRESS_B, method: 'GET',
    requestPath: '/api/v1/chat/events', device: 'http-stream-0001',
  });
  assert.equal(verifySignedRequest({
    method: 'GET', path: '/api/v1/chat/events', headers: handshake.headers,
  }), ADDRESS_B);
  const response = await fetch(`${base}/api/v1/chat/events`, {
    headers: { ...handshake.headers, accept: 'text/event-stream' },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
  const reader = response.body.getReader();
  const state = { text: '' };
  await readUntil(reader, state, 'event: ready');

  const bKeys = x25519KeyPairFromSeed(SEED_B);
  const envelope = sealMessage({
    seed32: SEED_A, from: ADDRESS_A, to: ADDRESS_B,
    recipientX25519Pub: bKeys.publicKey, text: 'http wake',
  });
  const sent = signed({
    keyPair: KEY_A, address: ADDRESS_A, method: 'POST',
    requestPath: '/api/v1/chat/messages', body: { envelope },
  });
  const post = await fetch(`${base}/api/v1/chat/messages`, { method: 'POST', ...sent });
  assert.equal(post.status, 200);
  const { id } = await post.json();
  assert.equal(Number.isSafeInteger(id), true);

  await readUntil(reader, state, 'event: message');
  assert.match(state.text, new RegExp(`"id":${id}`));
  await reader.cancel();
});

test('the SSE route accepts the delegated chat identity used while the wallet is locked', async () => {
  // The browser signs chat requests with a chat key delegated by the wallet.
  // SSE must accept that v3 identity too; wallet-only verification makes the
  // stream answer 401 and the UI reconnect forever.
  const chatSeed = unhex('22'.repeat(32));
  const chat = nacl.sign.keyPair.fromSeed(chatSeed);
  const chatPub = Buffer.from(chat.publicKey).toString('base64');
  const delegation = signChatDelegation({
    walletSeed32: SEED_B, address: ADDRESS_B, chatPub,
  });
  const ts = Date.now();
  const nonce = `v3-http-${ts}-${Math.random().toString(36).slice(2, 10)}`;
  const device = 'http-chat-v3-0001';
  const signature = nacl.sign.detached(
    Buffer.from(chatIdentityRequestString({
      method: 'GET', path: '/api/v1/chat/events', address: ADDRESS_B,
      chatPub, ts, nonce, device,
    })),
    chat.secretKey,
  );
  chat.secretKey.fill(0);

  const response = await fetch(`${base}/api/v1/chat/events`, {
    headers: {
      accept: 'text/event-stream',
      'x-nsat-address': ADDRESS_B,
      'x-nsat-chat-pub': chatPub,
      'x-nsat-chat-delegation': delegation,
      'x-nsat-device': device,
      'x-nsat-ts': String(ts),
      'x-nsat-nonce': nonce,
      'x-nsat-signature': Buffer.from(signature).toString('base64'),
    },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
  const reader = response.body.getReader();
  const state = { text: '' };
  await readUntil(reader, state, 'event: ready');
  await reader.cancel();
});
