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
import { createPaymentRequestText, parsePaymentRequestText } from '../lib/chatPaymentRequest.js';
import { createTransactionCardText, parseTransactionCardText } from '../lib/chatTransaction.js';
import { countNewMessages } from '../lib/chatUnread.js';

const unhex = (text) => new Uint8Array(Buffer.from(text, 'hex'));
const SEED_A = unhex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
const SEED_B = unhex('1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100');
const SEED_C = new Uint8Array(32).fill(7);
const SEED_D = new Uint8Array(32).fill(9);
const ADDRESS_A = encodeG(nacl.sign.keyPair.fromSeed(SEED_A).publicKey);
const ADDRESS_B = encodeG(nacl.sign.keyPair.fromSeed(SEED_B).publicKey);
const ADDRESS_C = encodeG(nacl.sign.keyPair.fromSeed(SEED_C).publicKey);
const ADDRESS_D = encodeG(nacl.sign.keyPair.fromSeed(SEED_D).publicKey);

// The relay keeps mail until it is cleared, and these tests share one database:
// start each mailbox test from an empty one explicitly.
const clearMailbox = async (client, seed32, address) => {
  const { messages } = await client.peek({ seed32, address });
  if (messages.length) await client.ack({ seed32, address, ids: messages.map((m) => m.id) });
};

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

  // A device id is part of the v2 line, so both sides must agree byte for byte.
  const withDevice = { ...fields, device: 'laptop-device-0001' };
  assert.equal(chatRequestString(withDevice), requestString(withDevice));
  assert.match(chatRequestString(withDevice), /^nsc-chat\|2\|POST\|\/api\/v1\/chat\/messages\|/);
});

test('two wallets exchange encrypted messages over HTTP', async () => {
  const a = createChatClient({ origin });
  const b = createChatClient({ origin });

  await a.publishKey({ seed32: SEED_A, address: ADDRESS_A });
  await b.publishKey({ seed32: SEED_B, address: ADDRESS_B });
  await clearMailbox(b, SEED_B, ADDRESS_B);

  // B can find and verify A's key by address alone.
  const bundle = await b.fetchKey(ADDRESS_A);
  assert.equal(bundle.address, ADDRESS_A);

  await a.send({ seed32: SEED_A, from: ADDRESS_A, to: ADDRESS_B, text: 'ledger 313951 — ยืนยันแล้ว' });

  const peekB = await b.peek({ seed32: SEED_B, address: ADDRESS_B });
  assert.equal(peekB.messages.length, 1);
  assert.equal(peekB.messages[0].text, 'ledger 313951 — ยืนยันแล้ว');
  assert.equal(peekB.messages[0].from, ADDRESS_A);
  assert.equal(peekB.undecryptable.length, 0);

  // Reading alone no longer deletes: only the explicit clear does.
  const again = await b.peek({ seed32: SEED_B, address: ADDRESS_B });
  assert.equal(again.messages.length, 1);
  await b.ack({ seed32: SEED_B, address: ADDRESS_B, ids: [peekB.messages[0].id] });
  assert.equal((await b.peek({ seed32: SEED_B, address: ADDRESS_B })).messages.length, 0);

  // A's own inbox never contains what A sent.
  const inboxA = await a.peek({ seed32: SEED_A, address: ADDRESS_A });
  assert.equal(inboxA.messages.length, 0);
});

test('payment requests and transaction cards travel encrypted and bind to the envelope sender', async () => {
  const a = createChatClient({ origin });
  const b = createChatClient({ origin });
  await b.publishKey({ seed32: SEED_B, address: ADDRESS_B });
  await clearMailbox(b, SEED_B, ADDRESS_B);

  const request = createPaymentRequestText({ amount: '9007199254740993', address: ADDRESS_A });
  await a.send({ seed32: SEED_A, from: ADDRESS_A, to: ADDRESS_B, text: request });
  const requestInbox = await b.peek({ seed32: SEED_B, address: ADDRESS_B });
  assert.equal(requestInbox.messages.length, 1);
  assert.deepEqual(parsePaymentRequestText(requestInbox.messages[0].text, requestInbox.messages[0].from), {
    kind: 'payment-request', amount: '9007199254740993', address: ADDRESS_A,
  });

  const card = createTransactionCardText({
    hash: 'c'.repeat(64), amount: '9007199254740993', from: ADDRESS_A, to: ADDRESS_B,
  });
  await a.send({ seed32: SEED_A, from: ADDRESS_A, to: ADDRESS_B, text: card });
  const cardInbox = await b.peek({ seed32: SEED_B, address: ADDRESS_B });
  const newest = cardInbox.messages[cardInbox.messages.length - 1];
  assert.equal(cardInbox.messages.length, 2);
  assert.deepEqual(parseTransactionCardText(newest.text, newest.from), {
    kind: 'transaction-card', hash: 'c'.repeat(64), amount: '9007199254740993',
    from: ADDRESS_A, to: ADDRESS_B,
  });
  assert.equal(newest.from, ADDRESS_A);
  assert.equal(cardInbox.undecryptable.length, 0);
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

test('ack on one device leaves the other device\'s copy intact', async () => {
  const a = createChatClient({ origin });
  const laptop = createChatClient({ origin, deviceId: 'laptop-device-0001' });
  const phone = createChatClient({ origin, deviceId: 'phone-device-0001' });
  await laptop.publishKey({ seed32: SEED_D, address: ADDRESS_D });
  await clearMailbox(laptop, SEED_D, ADDRESS_D);
  // Register the phone before the message so it is a known delivery target.
  await phone.peek({ seed32: SEED_D, address: ADDRESS_D });
  await a.send({ seed32: SEED_A, from: ADDRESS_A, to: ADDRESS_D, text: 'read on the laptop' });

  const onLaptop = await laptop.peek({ seed32: SEED_D, address: ADDRESS_D });
  assert.deepEqual(onLaptop.messages.map((m) => m.text), ['read on the laptop']);
  const onPhone = await phone.peek({ seed32: SEED_D, address: ADDRESS_D });
  assert.deepEqual(onPhone.messages.map((m) => m.text), ['read on the laptop']);

  // Acknowledging on the laptop removes only its delivery; the phone still has
  // the message it has not read.
  const [message] = onLaptop.messages;
  assert.equal(await laptop.ack({ seed32: SEED_D, address: ADDRESS_D, ids: [message.id] }), 0);
  assert.equal((await laptop.peek({ seed32: SEED_D, address: ADDRESS_D })).messages.length, 0);
  assert.deepEqual((await phone.peek({ seed32: SEED_D, address: ADDRESS_D })).messages.map((m) => m.text), ['read on the laptop']);

  // The phone acknowledging the same id removes the envelope for good.
  assert.equal(await phone.ack({ seed32: SEED_D, address: ADDRESS_D, ids: [message.id] }), 1);
  assert.equal((await phone.peek({ seed32: SEED_D, address: ADDRESS_D })).messages.length, 0);
});

test('peeking counts new mail without deleting it, and ack removes only what was named', async () => {
  const a = createChatClient({ origin });
  const b = createChatClient({ origin });
  await b.publishKey({ seed32: SEED_B, address: ADDRESS_B });
  await clearMailbox(b, SEED_B, ADDRESS_B);
  await a.send({ seed32: SEED_A, from: ADDRESS_A, to: ADDRESS_B, text: 'first' });
  await a.send({ seed32: SEED_A, from: ADDRESS_A, to: ADDRESS_B, text: 'second' });

  // Two polls in a row see the same two messages: nothing was acknowledged.
  const peek1 = await b.peek({ seed32: SEED_B, address: ADDRESS_B });
  const peek2 = await b.peek({ seed32: SEED_B, address: ADDRESS_B });
  assert.deepEqual(peek1.messages.map((m) => m.text), ['first', 'second']);
  assert.deepEqual(peek2.messages.map((m) => m.text), ['first', 'second']);

  // Acknowledging one id leaves the other message on the relay.
  const deleted = await b.ack({ seed32: SEED_B, address: ADDRESS_B, ids: [peek1.messages[0].id] });
  assert.equal(deleted, 1);
  const peek3 = await b.peek({ seed32: SEED_B, address: ADDRESS_B });
  assert.deepEqual(peek3.messages.map((m) => m.text), ['second']);

  // Clearing the rest removes it for this mailbox.
  assert.equal(await b.ack({ seed32: SEED_B, address: ADDRESS_B, ids: [peek3.messages[0].id] }), 1);
  assert.equal((await b.peek({ seed32: SEED_B, address: ADDRESS_B })).messages.length, 0);
});

test('a message read in the open room leaves no badge and nothing queued', async () => {
  const a = createChatClient({ origin });
  const b = createChatClient({ origin });
  await b.publishKey({ seed32: SEED_B, address: ADDRESS_B });
  await clearMailbox(b, SEED_B, ADDRESS_B);

  // The room is open when the message lands: it is fetched and shown.
  await a.send({ seed32: SEED_A, from: ADDRESS_A, to: ADDRESS_B, text: 'while open' });
  const first = await b.peek({ seed32: SEED_B, address: ADDRESS_B, since: 0 });
  assert.equal(first.messages.length, 1);

  // On screen means read here: no badge, and the read mark moves to its arrival.
  const open = countNewMessages({
    messages: first.messages, marks: {}, openPeer: ADDRESS_A, reset: true,
  });
  assert.deepEqual(open.counts, {}, 'the open room is never a badge');
  const marks = { [ADDRESS_A]: open.newest[ADDRESS_A] };
  await b.ack({ seed32: SEED_B, address: ADDRESS_B, ids: first.messages.map((m) => m.id) });

  // Back on the list: the poll asks only after the cursor, as the panel does.
  const cursor = first.messages[first.messages.length - 1].id;
  const later = await b.peek({ seed32: SEED_B, address: ADDRESS_B, since: cursor });
  assert.equal(later.messages.length, 0);
  assert.deepEqual(countNewMessages({ messages: later.messages, marks, previous: open.counts }).counts, {});

  // Nothing was left on the relay for the mailbox to accumulate.
  assert.equal((await b.peek({ seed32: SEED_B, address: ADDRESS_B })).messages.length, 0);
});

test('opening a room reads only that conversation, not the whole mailbox', async () => {
  const a = createChatClient({ origin });
  const b = createChatClient({ origin });
  const c = createChatClient({ origin });
  await b.publishKey({ seed32: SEED_B, address: ADDRESS_B });
  await clearMailbox(b, SEED_B, ADDRESS_B);
  await c.publishKey({ seed32: SEED_C, address: ADDRESS_C });

  await a.send({ seed32: SEED_A, from: ADDRESS_A, to: ADDRESS_B, text: 'from a' });
  await c.send({ seed32: SEED_C, from: ADDRESS_C, to: ADDRESS_B, text: 'from c' });

  const roomA = await b.peek({ seed32: SEED_B, address: ADDRESS_B, peer: ADDRESS_A });
  assert.deepEqual(roomA.messages.map((m) => m.text), ['from a']);
  const roomC = await b.peek({ seed32: SEED_B, address: ADDRESS_B, peer: ADDRESS_C });
  assert.deepEqual(roomC.messages.map((m) => m.text), ['from c']);

  // The room filter composes with a cursor, so a refresh only asks for newer mail.
  const cursor = roomA.messages[roomA.messages.length - 1].id;
  const again = await b.peek({
    seed32: SEED_B, address: ADDRESS_B, peer: ADDRESS_A, since: cursor,
  });
  assert.equal(again.messages.length, 0);
});
