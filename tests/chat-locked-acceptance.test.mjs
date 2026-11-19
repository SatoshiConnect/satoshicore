// Acceptance coverage for the locked-wallet requirement:
//
//   chat, payment inbox, archive and tab coordination keep working without the
//   wallet seed; only sending NSAT asks for a fresh password/passkey approval.
//
// The transport tests use the real relay and the real chat client without ever
// supplying `seed32` after the one-time identity setup. The final contract test
// guards the UI wiring: a wallet credential must not become the gate for chat.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, afterEach } from 'node:test';

import nacl from 'tweetnacl';
import { createChatClient } from '../lib/chatClient.js';
import { ensureChatIdentity } from '../lib/chatIdentity.js';
import {
  archiveMessages, deriveArchiveKey, forgetArchiveKeys, openArchiveText, readArchivedRows,
} from '../lib/chatArchive.js';
import { createPaymentRequestText } from '../lib/chatPaymentRequest.js';
import {
  paymentRequestFromMessage, readPaymentRequests, upsertPaymentRequests,
} from '../lib/chatPaymentInbox.js';
import { createChatRelay } from '../services/api-gateway/chat-relay.mjs';
import { encodeG } from '../lib/nsatCodec.js';
import { createChatTabSync } from '../lib/chatTabSync.js';
import { FakeIndexedDB } from './helpers/fakeIndexedDb.mjs';

const SEED_A = new Uint8Array(32).fill(41);
const SEED_B = new Uint8Array(32).fill(73);
const ADDRESS_A = encodeG(nacl.sign.keyPair.fromSeed(SEED_A).publicKey);
const ADDRESS_B = encodeG(nacl.sign.keyPair.fromSeed(SEED_B).publicKey);

const memoryStorage = () => {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); },
  };
};

let dir;
let relay;
let server;
let origin;

before(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'nsat-locked-acceptance-'));
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

afterEach(() => {
  delete globalThis.indexedDB;
  forgetArchiveKeys();
});

class FakeLocks {
  constructor() {
    this.held = false;
    this.waiting = [];
  }

  request(_name, callback) {
    return new Promise((resolve, reject) => {
      const run = async () => {
        this.held = true;
        try {
          await callback();
          resolve();
        } catch (error) {
          reject(error);
        } finally {
          this.held = false;
          const next = this.waiting.shift();
          if (next) next();
        }
      };
      if (this.held) this.waiting.push(run);
      else void run();
    });
  }
}

class FakeChannel {
  static rooms = new Map();

  constructor(name) {
    this.name = name;
    this.onmessage = null;
    this.closed = false;
    const room = FakeChannel.rooms.get(name) || new Set();
    room.add(this);
    FakeChannel.rooms.set(name, room);
  }

  postMessage(value) {
    const payload = JSON.parse(JSON.stringify(value));
    for (const peer of FakeChannel.rooms.get(this.name) || []) {
      if (peer === this || peer.closed) continue;
      queueMicrotask(() => { if (!peer.closed) peer.onmessage?.({ data: payload }); });
    }
  }

  close() {
    this.closed = true;
    FakeChannel.rooms.get(this.name)?.delete(this);
  }
}

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

test('acceptance: a locked wallet still publishes, sends, reads inbox and acks with chat identity only', async () => {
  const storage = memoryStorage();
  const identityA = ensureChatIdentity({ address: ADDRESS_A, walletSeed32: SEED_A, storage });
  const identityB = ensureChatIdentity({ address: ADDRESS_B, walletSeed32: SEED_B, storage });
  assert.ok(identityA?.seed32 && identityB?.seed32);

  const a = createChatClient({ origin, deviceId: 'locked-acceptance-a-01' });
  const b = createChatClient({ origin, deviceId: 'locked-acceptance-b-01' });
  const text = 'locked chat acceptance';

  // From here on no wallet seed is supplied: this is the locked-wallet path.
  await a.publishKey({ chatIdentity: identityA, address: ADDRESS_A });
  await b.publishKey({ chatIdentity: identityB, address: ADDRESS_B });
  await b.peek({ chatIdentity: identityB, address: ADDRESS_B });
  await a.send({ chatIdentity: identityA, from: ADDRESS_A, to: ADDRESS_B, text });

  const firstInbox = await b.peek({ chatIdentity: identityB, address: ADDRESS_B });
  assert.equal(firstInbox.undecryptable.length, 0);
  const first = firstInbox.messages.find((message) => message.text === text);
  assert.ok(first, 'the locked recipient receives the message');
  assert.equal(await b.ack({
    chatIdentity: identityB, address: ADDRESS_B, ids: [first.id],
  }), 1);
  assert.equal((await b.peek({ chatIdentity: identityB, address: ADDRESS_B }))
    .messages.some((message) => message.id === first.id), false);

  // The payment inbox is local and must also open from the chat identity.
  globalThis.indexedDB = new FakeIndexedDB();
  const requestText = createPaymentRequestText({ amount: '125', address: ADDRESS_A });
  await a.send({ chatIdentity: identityA, from: ADDRESS_A, to: ADDRESS_B, text: requestText });
  const requestInbox = await b.peek({ chatIdentity: identityB, address: ADDRESS_B });
  const requestMessage = requestInbox.messages.find((message) => message.text === requestText);
  assert.ok(requestMessage);
  const request = paymentRequestFromMessage({ message: requestMessage, owner: ADDRESS_B });
  assert.ok(request);
  assert.equal(await upsertPaymentRequests({
    seed32: identityB.seed32, address: ADDRESS_B, requests: [request], keyScope: 'chat',
  }), 1);
  const stored = await readPaymentRequests({
    seed32: identityB.seed32, address: ADDRESS_B, keyScope: 'chat',
  });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].status, 'pending');

  // The wallet seed no longer opens the chat-scoped inbox.
  assert.equal((await readPaymentRequests({
    seed32: SEED_B, address: ADDRESS_B, keyScope: 'chat',
  })).length, 0);

  // The archive is likewise readable with the chat identity while locked.
  await archiveMessages({
    seed32: identityB.seed32,
    address: ADDRESS_B,
    peer: ADDRESS_A,
    scope: 'chat',
    messages: [requestMessage],
  });
  const rows = await readArchivedRows(ADDRESS_B);
  const row = rows.find((candidate) => String(candidate.id) === String(requestMessage.id));
  assert.ok(row);
  const opened = await openArchiveText(await deriveArchiveKey(identityB.seed32, ADDRESS_B, 'chat'), {
    ...row, address: ADDRESS_B,
  });
  assert.equal(opened?.text, requestText);
  assert.equal(await b.ack({
    chatIdentity: identityB, address: ADDRESS_B, ids: [requestMessage.id],
  }), 1);
});

test('acceptance: two tabs coordinate the reader without a wallet seed when the chat identity can lead', async () => {
  const locks = new FakeLocks();
  const snapshots = [];
  const first = createChatTabSync({
    wallet: ADDRESS_B,
    canLead: true,
    locks,
    Channel: FakeChannel,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  });
  const second = createChatTabSync({
    wallet: ADDRESS_B,
    canLead: true,
    locks,
    Channel: FakeChannel,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  });
  first.start();
  second.start();
  await flush();
  assert.equal(first.isLeader(), true);
  assert.equal(second.isLeader(), false);

  first.publish({ at: 10, counts: { [ADDRESS_A]: 2 } });
  await flush();
  assert.deepEqual(snapshots, [{ at: 10, counts: { [ADDRESS_A]: 2 } }]);

  first.close();
  await flush();
  assert.equal(second.isLeader(), true);
  second.close();
});

test('acceptance contract: chat is gated by identity, while only Send NSAT crosses the password/passkey boundary', () => {
  const chat = readFileSync(new URL('../components/ChatPanel.js', import.meta.url), 'utf8');
  const wallet = readFileSync(new URL('../components/WalletPanel.js', import.meta.url), 'utf8');

  // Chat, inbox and tab leadership must not depend on the wallet seed.
  assert.match(chat, /const readOnly = !chatIdentity \|\| !identityReady;/);
  assert.match(chat, /canLead: Boolean\(chatIdentity\)/);
  assert.doesNotMatch(chat, /readOnly = !seed32/);

  // The composer has no approval-password gate; the approval exists only on
  // the Send NSAT action.
  assert.match(chat, /disabled=\{readOnly \|\| state\.busy \|\| gate\.blocked \|\| !draft\.trim\(\)\}/);
  const sendStart = chat.indexOf('async function send(event)');
  const sendEnd = chat.indexOf('if (!relayConfigured)', sendStart);
  assert.ok(sendStart >= 0 && sendEnd > sendStart);
  assert.doesNotMatch(chat.slice(sendStart, sendEnd), /approvalPassword/);

  // A chat request also needs no wallet credential.
  const requestStart = chat.indexOf('async function sendPaymentRequest');
  const requestEnd = chat.indexOf('async function sendMoney', requestStart);
  assert.ok(requestStart >= 0 && requestEnd > requestStart);
  assert.doesNotMatch(chat.slice(requestStart, requestEnd), /approvalPassword/);

  // Send NSAT is the one path that asks for a fresh local approval and signs
  // with the resulting ephemeral seed.
  assert.match(chat, /onSendCoins\(peer, amount, approvalPassword, approvalMethod, address\)/);
  assert.match(chat, /const approvalReady = netVerified && fee != null && balance != null/);
  assert.doesNotMatch(chat, /const approvalReady = !readOnly/);
  assert.match(chat, /disabled=\{coin\.phase === 'sending' \|\| !approvalReady\}/);
  assert.match(wallet, /async function sendCoinsFromChat/);
  assert.match(wallet, /unlockWithBiometric\(wallet\.name, wallet\.pubkey\)/);
  assert.match(wallet, /keystoreUnlock\(wallet\.name, approvalPasswordInput\)/);
  assert.match(wallet, /approvalSeed: signingSeed/);
});