// Offline verification of the shared wallet engine with a synthetic identity.
//
// Nothing here touches the network or a real key: no fetch, no gateway, no
// broadcast, no Mainnet account. It proves the claims the UI makes about the
// engine — the seed is stored only as ciphertext, the displayed address is the
// signing key, a signed envelope verifies against that key, a backup restores
// the same key, and a tampered keystore is refused instead of silently trusted.
//
// Run: node --test tests/wallet-engine.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import {
  setWalletStorage,
  keystoreCreate, keystoreUnlock, keystoreList, keystoreExport, keystoreRestore,
  buildSignedTx, historyLoad, historyPush, historyPatch,
} from '../lib/nsatWallet.js';
import { ed25519Keypair, encodeG } from '../lib/nsatCodec.js';

const NAME = 'synthetic-check';
const PASS = 'synthetic-only-password';
const NET = 'synthetic passphrase — local signature check, never broadcast';

function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    raw: () => [...map.values()].join('\n'),
    clear: () => map.clear(),
  };
}

// A build that needs the network is a bug in these tests, not a slow test.
async function withNoNetwork(fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new Error(`unexpected network call in an offline test: ${String(url)}`);
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('synthetic keystore: ciphertext only, wrong password rejected, unlock matches address', async () => {
  await withNoNetwork(async () => {
    const storage = memoryStorage();
    setWalletStorage(storage);

    const created = await keystoreCreate(NAME, PASS);
    assert.match(created.pubkeyG, /^G[A-Z2-7]{55}$/);
    assert.match(created.seedS, /^S[A-Z2-7]{55}$/);

    // The backup seed exists exactly once (returned to the user) and is never
    // written to storage — only the AES-GCM box is.
    const stored = storage.raw();
    assert.ok(!stored.includes(created.seedS), 'plaintext seed must never be persisted');
    assert.ok(stored.includes('"box"'), 'keystore must persist an encrypted box');

    await assert.rejects(() => keystoreUnlock(NAME, 'wrong-password'), /wrong password/);

    const seed = await keystoreUnlock(NAME, PASS);
    assert.equal(seed.length, 32);
    assert.equal(encodeG(ed25519Keypair(seed).pub32), created.pubkeyG,
      'unlocked key must derive the stored address');
    assert.deepEqual(keystoreList(), [{ name: NAME, pubkey: created.pubkeyG }]);
  });
});

test('signed envelope verifies locally, is deterministic, and binds the tx hash', async () => {
  await withNoNetwork(async () => {
    const storage = memoryStorage();
    setWalletStorage(storage);
    const created = await keystoreCreate(NAME, PASS);
    const seed = await keystoreUnlock(NAME, PASS);
    const dest = encodeG(ed25519Keypair(new Uint8Array(32).fill(9)).pub32);

    const one = await buildSignedTx({
      seed32: seed, netPassphrase: NET, destG: dest, amount: '1', fee: 10, seq: 7,
    });
    const two = await buildSignedTx({
      seed32: seed, netPassphrase: NET, destG: dest, amount: '1', fee: 10, seq: 7,
    });

    assert.equal(one.pubkeyG, created.pubkeyG, 'envelope source must be the stored address');
    assert.equal(one.seq, 7);
    assert.equal(one.envelopeBase64, two.envelopeBase64, 'Ed25519 signatures are deterministic');
    assert.equal(one.txHashHex, two.txHashHex);

    const envelope = Uint8Array.from(Buffer.from(one.envelopeBase64, 'base64'));
    const sig = envelope.subarray(envelope.length - 64);
    const hint = envelope.subarray(envelope.length - 72, envelope.length - 68);
    const pub32 = ed25519Keypair(seed).pub32;
    const message = Uint8Array.from(Buffer.from(one.txHashHex, 'hex'));

    assert.equal(nacl.sign.detached.verify(message, sig, pub32), true,
      'the envelope signature must verify against the derived public key');
    assert.deepEqual([...hint], [...pub32.subarray(28)],
      'signature hint must be the last four bytes of the source key');

    // Flip one bit of the signed message: the same signature must not verify.
    const tampered = Uint8Array.from(message);
    tampered[0] ^= 0x01;
    assert.equal(nacl.sign.detached.verify(tampered, sig, pub32), false);
  });
});

test('backup restores the same key; a tampered keystore is refused', async () => {
  await withNoNetwork(async () => {
    const storage = memoryStorage();
    setWalletStorage(storage);
    const created = await keystoreCreate(NAME, PASS);
    const backup = keystoreExport();
    assert.ok(backup.includes('wallets'));

    // Restore onto an empty device: the same address, the same password.
    storage.clear();
    keystoreRestore(backup);
    const restoredSeed = await keystoreUnlock(NAME, PASS);
    assert.equal(encodeG(ed25519Keypair(restoredSeed).pub32), created.pubkeyG);

    // Structurally invalid backup: rejected before it can replace the keystore.
    const malformed = JSON.parse(backup);
    malformed.wallets[0].pubkey = 'not-an-address';
    assert.throws(() => keystoreRestore(JSON.stringify(malformed)), /malformed keystore entry/);
    assert.equal(keystoreList()[0].pubkey, created.pubkeyG, 'live keystore must survive a bad restore');

    // Address swapped for another valid address: restore is structurally fine,
    // but unlocking must refuse — a phishing keystore cannot sign as this name.
    const swapped = JSON.parse(backup);
    swapped.wallets[0].pubkey = encodeG(ed25519Keypair(new Uint8Array(32).fill(5)).pub32);
    storage.clear();
    keystoreRestore(JSON.stringify(swapped));
    await assert.rejects(() => keystoreUnlock(NAME, PASS), /integrity failure/);

    // Ciphertext flipped: authenticated encryption rejects it.
    const corrupted = JSON.parse(backup);
    const box = corrupted.wallets[0].box;
    corrupted.wallets[0].box = (box[0] === 'A' ? 'B' : 'A') + box.slice(1);
    storage.clear();
    keystoreRestore(JSON.stringify(corrupted));
    await assert.rejects(() => keystoreUnlock(NAME, PASS), /wrong password/);
  });
});

test('history records a transfer and patches it by transaction hash', async () => {
  const storage = memoryStorage();
  setWalletStorage(storage);
  const txHash = 'ab'.repeat(32);

  historyPush(NAME, {
    dir: 'sent', to: 'G'.padEnd(56, 'A'), amount: '1', fee: 10,
    status: 'pending', txhash: txHash, time: 'synthetic',
  });
  historyPush(NAME, { dir: 'received', amount: '2', status: 'confirmed', txhash: 'cd'.repeat(32) });

  const patched = historyPatch(NAME, txHash, { status: 'confirmed', ledger: 42 });
  const row = patched.find((h) => h.txhash === txHash);
  assert.equal(row.status, 'confirmed');
  assert.equal(row.ledger, 42);
  assert.equal(historyLoad(NAME).length, 2);
  assert.equal(historyLoad(NAME)[1].status, 'confirmed', 'unrelated rows are untouched');
});
