import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  base64ToBytes, bytesToHex, concat, encodeG, ed25519Keypair,
  sha256, u32Bytes,
} from '../lib/nsatCodec.js';
import { buildSignedTx } from '../lib/nsatWallet.js';

const seed32 = Uint8Array.from({ length: 32 }, (_, i) => i);
const destG = encodeG(ed25519Keypair(new Uint8Array(32).fill(9)).pub32);
const base = { seed32, netPassphrase: 'Disposable Phase 4 test', destG,
  fee: 10, seq: 7 };

test('transaction builder rejects zero and out-of-range amounts', async () => {
  await assert.rejects(buildSignedTx({ ...base, amount: '0' }), /positive integer/);
  await assert.rejects(buildSignedTx({ ...base, amount: '9223372036854775808' }), /per-operation limit/);
});

test('transaction builder rejects malformed fee, sequence and network', async () => {
  await assert.rejects(buildSignedTx({ ...base, amount: '1', fee: 4294967306 }), /uint32/);
  await assert.rejects(buildSignedTx({ ...base, amount: '1', seq: 0 }), /sequence number/);
  await assert.rejects(buildSignedTx({ ...base, amount: '1', netPassphrase: '' }), /network identity/);
});

test('transaction hash matches the Core contents-hash domain', async () => {
  const signed = await buildSignedTx({ ...base, amount: '123' });
  const envelope = base64ToBytes(signed.envelopeBase64);
  const txV0 = envelope.subarray(4, envelope.length - 76);
  const networkId = await sha256(new TextEncoder().encode(base.netPassphrase));
  const expected = bytesToHex(await sha256(concat(
    networkId, u32Bytes(2), u32Bytes(0), txV0)));
  assert.equal(signed.txHashHex, expected);
});
