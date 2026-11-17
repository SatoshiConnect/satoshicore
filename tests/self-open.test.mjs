// Offline verification of the V_16 free self-open path.
//
// The transaction the wallet signs must be exactly the shape Core's
// isSelfOpenTx() accepts: one CREATE_ACCOUNT of 0 NSAT, transaction source =
// op source = destination, fee 0, sequence 0, no preconditions, no extension.
// Anything else is rejected on chain (txNO_ACCOUNT / txINSUFFICIENT_FEE), so
// these assertions are the contract, not a formality.
import test from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';

import { sha256, payloadSignatureInput, encodeG } from '../lib/nsatCodec.js';
import {
  buildSelfOpenTx, selfOpenGate, SELF_OPEN_PROTOCOL_VERSION,
} from '../lib/nsatSelfOpen.js';

const NET = 'NSAT Mainnet ; October 2026 ; bc3098829fffc717';
const seed32 = new Uint8Array(32).fill(7);
const kp = nacl.sign.keyPair.fromSeed(seed32);

function b64ToBytes(s) {
  const bin = Buffer.from(s, 'base64');
  return new Uint8Array(bin);
}
function same(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

class Reader {
  constructor(buf) { this.buf = buf; this.off = 0; }
  u32() {
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.off, 4).getUint32(0);
    this.off += 4;
    return v;
  }
  u64() {
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.off, 8).getBigUint64(0);
    this.off += 8;
    return v;
  }
  bytes(n) {
    const v = this.buf.slice(this.off, this.off + n);
    this.off += n;
    return v;
  }
}

test('gate: self-open needs protocol 16 and fails closed otherwise', () => {
  assert.equal(SELF_OPEN_PROTOCOL_VERSION, 16);
  assert.equal(selfOpenGate({ protocolVersion: 15 }).available, false);
  assert.match(selfOpenGate({ protocolVersion: 15 }).reason, /protocol 16/);
  assert.equal(selfOpenGate({ protocolVersion: 16 }).available, true);
  assert.equal(selfOpenGate({ protocolVersion: 17 }).available, true);
  assert.equal(selfOpenGate({ protocolVersion: null }).available, false);
  assert.equal(selfOpenGate({ protocolVersion: 'x' }).available, false);
});

test('self-open transaction has the exact fee-free shape', async () => {
  const out = await buildSelfOpenTx({ seed32, netPassphrase: NET });
  assert.equal(out.pubkeyG, encodeG(kp.publicKey));

  const env = b64ToBytes(out.envelopeBase64);
  const rd = new Reader(env);
  assert.equal(rd.u32(), 2, 'envelope type must be TX (2)');

  // Transaction body: source | fee | seq | cond | memo | ops | ext
  assert.equal(rd.u32(), 0, 'sourceAccount must be an ed25519 key');
  assert.ok(same(rd.bytes(32), kp.publicKey), 'source is the key being opened');
  assert.equal(rd.u32(), 0, 'fee must be 0 — nobody is charged');
  assert.equal(rd.u64(), 0n, 'seq must be 0 — no account exists to advance');
  assert.equal(rd.u32(), 0, 'no preconditions');
  assert.equal(rd.u32(), 0, 'no memo');
  assert.equal(rd.u32(), 1, 'exactly one operation');

  // The single operation: CREATE_ACCOUNT(dest = this key, amount = 0),
  // sourced by the same key.
  assert.equal(rd.u32(), 1, 'op sourceAccount must be present');
  assert.equal(rd.u32(), 0, 'op source is an ed25519 key');
  assert.ok(same(rd.bytes(32), kp.publicKey), 'op source is the key being opened');
  assert.equal(rd.u32(), 0, 'operation must be CREATE_ACCOUNT');
  assert.equal(rd.u32(), 0, 'destination is an ed25519 key');
  assert.ok(same(rd.bytes(32), kp.publicKey), 'destination is the same key');
  assert.ok(same(rd.bytes(16), new Uint8Array(16)), 'starting balance is exactly 0');
  assert.equal(rd.u32(), 0, 'no transaction extension');

  // One signature, the wallet key, over the network-scoped payload.
  assert.equal(rd.u32(), 1, 'exactly one signature');
  assert.ok(same(rd.bytes(4), kp.publicKey.subarray(28)), 'hint is the signing key');
  assert.equal(rd.u32(), 64);
  const sig = rd.bytes(64);
  assert.equal(rd.off, env.length, 'no trailing bytes');

  const netId = await sha256(new TextEncoder().encode(NET));
  // env = u32(type) | tx | u32(count) | hint(4) | u32(64) | sig(64)
  const txLen = env.length - 4 - 4 - 4 - 4 - 64;
  const tx = env.slice(4, 4 + txLen);
  const digest = await sha256(payloadSignatureInput(netId, tx));
  assert.ok(nacl.sign.detached.verify(digest, sig, kp.publicKey), 'signature must verify');

  // The wallet reports the transaction hash, not the contents hash.
  let hex = '';
  for (const b of await sha256(tx)) hex += b.toString(16).padStart(2, '0');
  assert.equal(out.txHashHex, hex);
});
