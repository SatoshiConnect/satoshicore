import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import nacl from 'tweetnacl';
import { createChatClient, chatIdentityRequestString } from '../lib/chatClient.js';
import {
  chatIdentityStorageKey, ensureChatIdentity, ensureChatIdentityAcrossTabs, readChatIdentity,
  saveChatIdentity,
} from '../lib/chatIdentity.js';
import { verifyChatDelegation } from '../lib/e2eChat.js';
import { chatIdentityRequestString as relayIdentityRequestString, createChatRelay } from '../services/api-gateway/chat-relay.mjs';
import { encodeG } from '../lib/nsatCodec.js';

const SEED_A = new Uint8Array(32).fill(3);
const SEED_B = new Uint8Array(32).fill(5);
const WALLET_A = encodeG(nacl.sign.keyPair.fromSeed(SEED_A).publicKey);
const WALLET_B = encodeG(nacl.sign.keyPair.fromSeed(SEED_B).publicKey);

const memoryStorage = () => {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
};

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
          resolve(await callback());
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

let dir;
let relay;
let server;
let origin;

before(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'nsat-chat-identity-'));
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

test('the client and relay agree on the v3 chat-identity request line', () => {
  const fields = {
    method: 'GET', path: '/api/v1/chat/messages', address: WALLET_A,
    chatPub: 'Y2hhdC1wdWJsaWMta2V5', ts: 1_763_000_000_000, nonce: 'abcdef0123456789',
  };
  assert.equal(chatIdentityRequestString(fields), relayIdentityRequestString(fields));
  assert.match(chatIdentityRequestString(fields), /^nsc-chat\|3\|GET\|/);
});

test('a chat identity is created once with the wallet and then read without its seed', () => {
  const storage = memoryStorage();
  const created = ensureChatIdentity({
    address: WALLET_A, walletSeed32: SEED_A, storage,
  });
  assert.ok(created);
  assert.equal(created.address, WALLET_A);
  assert.equal(created.v, 2);
  assert.equal(verifyChatDelegation({
    address: WALLET_A, chatPub: created.chatPub, delegation: created.delegation,
  }), true);
  assert.equal(storage.getItem(chatIdentityStorageKey(WALLET_A)) !== null, true);

  // A locked wallet has no seed; the stored identity must still load.
  const loaded = readChatIdentity(WALLET_A, storage);
  assert.deepEqual(loaded, created);
  assert.equal(readChatIdentity(WALLET_B, storage), null);
});

test('two tabs that unlock together adopt the same chat identity', async () => {
  const storage = memoryStorage();
  const locks = new FakeLocks();
  const [first, second] = await Promise.all([
    ensureChatIdentityAcrossTabs({ address: WALLET_A, walletSeed32: SEED_A, storage, locks }),
    ensureChatIdentityAcrossTabs({ address: WALLET_A, walletSeed32: SEED_A, storage, locks }),
  ]);
  assert.ok(first && second);
  assert.equal(first.chatPub, second.chatPub);
  assert.equal(readChatIdentity(WALLET_A, storage).chatPub, first.chatPub);
});

test('an identity saved for one address is rejected for another', () => {
  const storage = memoryStorage();
  const identity = ensureChatIdentity({ address: WALLET_A, walletSeed32: SEED_A, storage });
  assert.ok(identity);
  assert.equal(saveChatIdentity({ ...identity, address: WALLET_B }, storage), true);
  assert.equal(readChatIdentity(WALLET_B, storage), null);
});

test('two locked wallets exchange chat with only their chat identities', async () => {
  const storage = memoryStorage();
  const identityA = ensureChatIdentity({ address: WALLET_A, walletSeed32: SEED_A, storage });
  const identityB = ensureChatIdentity({ address: WALLET_B, walletSeed32: SEED_B, storage });
  const a = createChatClient({ origin });
  const b = createChatClient({ origin });

  // No seed32 is passed after this point: this is the locked-wallet path.
  await a.publishKey({ chatIdentity: identityA, address: WALLET_A });
  const bundleB = await b.publishKey({ chatIdentity: identityB, address: WALLET_B });
  assert.notEqual(bundleB.x25519Pub, bundleB.x25519ChatPub);
  const before = await b.peek({ chatIdentity: identityB, address: WALLET_B });
  if (before.messages.length) {
    await b.ack({ chatIdentity: identityB, address: WALLET_B, ids: before.messages.map((m) => m.id) });
  }

  await a.send({
    chatIdentity: identityA, from: WALLET_A, to: WALLET_B, text: 'locked chat works',
  });
  const received = await b.peek({ chatIdentity: identityB, address: WALLET_B });
  assert.equal(received.undecryptable.length, 0);
  assert.deepEqual(received.messages.map((message) => message.text), ['locked chat works']);
  assert.equal(received.messages[0].from, WALLET_A);
  await b.ack({ chatIdentity: identityB, address: WALLET_B, ids: [received.messages[0].id] });

  // A v1 client that only knows the wallet seed can still write to a v2
  // recipient: its v1 envelope uses the legacy wallet X25519 key in the bundle.
  const legacyToNew = createChatClient({ origin });
  await legacyToNew.send({
    seed32: SEED_A, from: WALLET_A, to: WALLET_B, text: 'legacy sender still works',
  });
  const legacyInbox = await b.peek({ seed32: SEED_B, address: WALLET_B });
  assert.ok(legacyInbox.messages.some((message) => message.text === 'legacy sender still works'));
});

test('a delegation for one wallet cannot be used to publish for another', async () => {
  const storage = memoryStorage();
  const identity = ensureChatIdentity({ address: WALLET_A, walletSeed32: SEED_A, storage });
  const client = createChatClient({ origin });
  await assert.rejects(
    client.publishKey({ chatIdentity: { ...identity, address: WALLET_B }, address: WALLET_B }),
    /refused/,
  );
});