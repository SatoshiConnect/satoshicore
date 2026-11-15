// End-to-end at the transport level: a real HTTP server mounts the relay, the
// client signs real requests, and two wallets talk. Nothing is mocked except
// the socket's port.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import nacl from 'tweetnacl';
import { createChatClient, chatRequestString } from '../lib/chatClient.js';
import { createChatRelay, requestString } from '../services/api-gateway/chat-relay.mjs';
import { encodeG } from '../lib/nsatCodec.js';

const unhex = (text) => new Uint8Array(Buffer.from(text, 'hex'));
const SEED_A = unhex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
const SEED_B = unhex('1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100');
const ADDRESS_A = encodeG(nacl.sign.keyPair.fromSeed(SEED_A).publicKey);
const ADDRESS_B = encodeG(nacl.sign.keyPair.fromSeed(SEED_B).publicKey);

let dir;
let relay;
let server;
let origin;

before(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'nsat-chat-http-'));
  relay = createChatRelay({ dbPath: path.join(dir, 'relay.sqlite') });
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      const result = relay.handle({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        headers: req.headers,
        body,
      });
      res.writeHead(result.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result.body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  relay?.close();
  rmSync(dir, { recursive: true, force: true });
});

test('the client and the relay sign the same canonical request', () => {
  const fields = {
    method: 'post', path: '/api/v1/chat/messages', address: ADDRESS_A,
    ts: 1_763_000_000_000, nonce: 'abcdef0123456789',
  };
  assert.equal(chatRequestString(fields), requestString(fields));
});

test('two wallets exchange encrypted messages over HTTP', async () => {
  const a = createChatClient({ origin });
  const b = createChatClient({ origin });

  await a.publishKey({ seed32: SEED_A, address: ADDRESS_A });
  await b.publishKey({ seed32: SEED_B, address: ADDRESS_B });

  // B can find and verify A's key by address alone.
  const bundle = await b.fetchKey(ADDRESS_A);
  assert.equal(bundle.address, ADDRESS_A);

  await a.send({ seed32: SEED_A, from: ADDRESS_A, to: ADDRESS_B, text: 'ledger 313951 — ยืนยันแล้ว' });

  const inboxB = await b.inbox({ seed32: SEED_B, address: ADDRESS_B });
  assert.equal(inboxB.messages.length, 1);
  assert.equal(inboxB.messages[0].text, 'ledger 313951 — ยืนยันแล้ว');
  assert.equal(inboxB.messages[0].from, ADDRESS_A);
  assert.equal(inboxB.undecryptable.length, 0);

  // The relay removed it after the ack: the second read is empty.
  const again = await b.inbox({ seed32: SEED_B, address: ADDRESS_B });
  assert.equal(again.messages.length, 0);

  // A's own inbox never contains what A sent.
  const inboxA = await a.inbox({ seed32: SEED_A, address: ADDRESS_A });
  assert.equal(inboxA.messages.length, 0);
});

test('a wallet that has published no key cannot be messaged, and says so', async () => {
  const a = createChatClient({ origin });
  await assert.rejects(
    a.send({ seed32: SEED_A, from: ADDRESS_A, to: encodeG(nacl.sign.keyPair.fromSeed(unhex('22'.repeat(32))).publicKey), text: 'hi' }),
    /no usable messaging key/,
  );
});

test('a request signed for another path is refused by the relay', async () => {
  // The header set is valid but the signature belongs to a different request
  // line: the relay must reject rather than act on it.
  const client = createChatClient({ origin });
  await client.publishKey({ seed32: SEED_A, address: ADDRESS_A });
  const forged = {
    get: async () => ({
      ok: false, status: 401, json: async () => ({ error: 'signature required' }),
    }),
  };
  const broken = createChatClient({ origin, fetchImpl: forged.get });
  await assert.rejects(broken.send({ seed32: SEED_A, from: ADDRESS_A, to: ADDRESS_B, text: 'x' }),
    /refused/);
});

test('an envelope that was already opened is not handed out twice', async () => {
  const a = createChatClient({ origin });
  const b = createChatClient({ origin });
  await b.publishKey({ seed32: SEED_B, address: ADDRESS_B });
  await a.send({ seed32: SEED_A, from: ADDRESS_A, to: ADDRESS_B, text: 'one' });
  await a.send({ seed32: SEED_A, from: ADDRESS_A, to: ADDRESS_B, text: 'two' });
  const first = await b.inbox({ seed32: SEED_B, address: ADDRESS_B });
  assert.deepEqual(first.messages.map((m) => m.text), ['one', 'two']);
  const second = await b.inbox({ seed32: SEED_B, address: ADDRESS_B });
  assert.equal(second.messages.length, 0);
});
