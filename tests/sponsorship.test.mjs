// Offline verification of the sponsored-account wallet path.
//
// Everything here is pure byte handling plus ed25519: it proves that the
// wallet (1) refuses any transaction that is not the sponsored-open shape it
// expects, and (2) produces a two-signature TransactionV1 envelope whose
// signatures verify over the exact bytes the core will digest.
import test from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';

import {
  buildTxV1, buildEnvelopeV1, encodeG, bytesToBase64, base64ToBytes, u32Bytes,
  concat,
} from '../lib/nsatCodec.js';
import {
  SPONSORSHIP_PROTOCOL_VERSION, sponsorshipGate, reserveForNewAccount,
  buildSponsoredOpenTx, verifySponsoredOpenTx, coSignSponsoredOpen,
  verifyTxSignature, readEnvelopeSignatures,
} from '../lib/nsatSponsorship.js';

const NET = 'NSAT Mainnet ; October 2026 ; bc3098829fffc717';
const seedOf = (byte) => new Uint8Array(32).fill(byte);
const kpOf = (byte) => nacl.sign.keyPair.fromSeed(seedOf(byte));

const sponsor = kpOf(1);
const user = kpOf(2);
const other = kpOf(3);

const FEE = 10;
const SEQ = 42;

function opBegin(sponsorPub, sponsoredPub) {
  return concat(u32Bytes(1), u32Bytes(0), sponsorPub, u32Bytes(16), u32Bytes(0), sponsoredPub);
}
function opCreate(sponsorPub, destPub, amountBytes) {
  return concat(u32Bytes(1), u32Bytes(0), sponsorPub, u32Bytes(0),
    u32Bytes(0), destPub, amountBytes);
}
function opEnd(userPub) {
  return concat(u32Bytes(1), u32Bytes(0), userPub, u32Bytes(17));
}
const ZERO_AMOUNT = new Uint8Array(16);

test('gate: protocol 29 is refused, protocol 30 is open', () => {
  const old = sponsorshipGate({ protocolVersion: 29, policyEnabled: true });
  assert.equal(old.available, false);
  assert.match(old.reason, /protocol 30/);

  const now = sponsorshipGate({ protocolVersion: SPONSORSHIP_PROTOCOL_VERSION, policyEnabled: true });
  assert.equal(now.available, true);

  const closed = sponsorshipGate({ protocolVersion: 30, policyEnabled: false });
  assert.equal(closed.available, false);

  assert.equal(sponsorshipGate({ protocolVersion: null }).available, false);
  assert.equal(sponsorshipGate({ protocolVersion: 30 }).available, true);
});

test('reserve cost is exactly two base reserves', () => {
  assert.equal(reserveForNewAccount(100000000), 200000000n);
  assert.throws(() => reserveForNewAccount(0), /positive/);
});

test('operator transaction verifies for the expected account', () => {
  const { txXdr } = buildSponsoredOpenTx({
    sponsorPub32: sponsor.publicKey, newPub32: user.publicKey, fee: FEE, seq: SEQ,
  });
  const v = verifySponsoredOpenTx(txXdr, user.publicKey);
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.sponsorG, encodeG(sponsor.publicKey));
  assert.equal(v.fee, FEE);
  assert.equal(v.seq, BigInt(SEQ));
});

test('a transaction that creates a different account is refused', () => {
  const ops = [
    opBegin(sponsor.publicKey, other.publicKey),
    opCreate(sponsor.publicKey, other.publicKey, ZERO_AMOUNT),
    opEnd(other.publicKey),
  ];
  const tx = bytesToBase64(buildTxV1(sponsor.publicKey, FEE, SEQ, ops));
  const v = verifySponsoredOpenTx(tx, user.publicKey);
  assert.equal(v.ok, false);
  assert.match(v.reason, /sponsors a different account/);
});

test('a create with a non-zero starting balance is refused', () => {
  const amount = new Uint8Array(16);
  new DataView(amount.buffer).setUint32?.(0, 0); // hi = 0 (big-endian int64)
  amount[15] = 1; // lo = 1 stroop
  const ops = [
    opBegin(sponsor.publicKey, user.publicKey),
    opCreate(sponsor.publicKey, user.publicKey, amount),
    opEnd(user.publicKey),
  ];
  const tx = bytesToBase64(buildTxV1(sponsor.publicKey, FEE, SEQ, ops));
  const v = verifySponsoredOpenTx(tx, user.publicKey);
  assert.equal(v.ok, false);
  assert.match(v.reason, /must start at 0 NSAT/);
});

test('operations out of order are refused', () => {
  const ops = [
    opCreate(sponsor.publicKey, user.publicKey, ZERO_AMOUNT),
    opBegin(sponsor.publicKey, user.publicKey),
    opEnd(user.publicKey),
  ];
  const tx = bytesToBase64(buildTxV1(sponsor.publicKey, FEE, SEQ, ops));
  const v = verifySponsoredOpenTx(tx, user.publicKey);
  assert.equal(v.ok, false);
  assert.match(v.reason, /not BEGIN_SPONSORING/);
});

test('two extra operations are refused', () => {
  const ops = [
    opBegin(sponsor.publicKey, user.publicKey),
    opCreate(sponsor.publicKey, user.publicKey, ZERO_AMOUNT),
    opEnd(user.publicKey),
    opEnd(user.publicKey),
  ];
  const tx = bytesToBase64(buildTxV1(sponsor.publicKey, FEE, SEQ, ops));
  const v = verifySponsoredOpenTx(tx, user.publicKey);
  assert.equal(v.ok, false);
  assert.match(v.reason, /unexpected transaction size/);
});

test('co-signing yields a valid two-signature envelope', async () => {
  const { txXdr } = buildSponsoredOpenTx({
    sponsorPub32: sponsor.publicKey, newPub32: user.publicKey, fee: FEE, seq: SEQ,
  });
  const tx = base64ToBytes(txXdr);

  // Operator side: sign the payload and wrap it in a single-signature envelope.
  const netId = new Uint8Array(await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(NET)));
  const payload = new Uint8Array(await crypto.subtle.digest(
    'SHA-256', concat(netId, u32Bytes(2), tx)));
  const sponsorSig = nacl.sign.detached(payload, sponsor.secretKey);

  const sponsorEnvelope = bytesToBase64(concat(
    u32Bytes(2), tx, u32Bytes(1),
    sponsor.publicKey.subarray(28), u32Bytes(64), sponsorSig));

  const prior = readEnvelopeSignatures(sponsorEnvelope, txXdr);
  assert.equal(prior.length, 1);
  assert.deepEqual([...prior[0].hint], [...sponsor.publicKey.subarray(28)]);

  const out = await coSignSponsoredOpen({
    txXdrB64: txXdr,
    envelopeXdrB64: sponsorEnvelope,
    seed32: seedOf(2),
    netPassphrase: NET,
    expectedPub32: user.publicKey,
  });

  const env = base64ToBytes(out.envelopeBase64);
  assert.equal(new DataView(env.buffer).getUint32(0), 2); // ENVELOPE_TYPE_TX
  // Two signatures: sponsor (from the payload) and the new account.
  const sigCountOffset = 4 + tx.length;
  assert.equal(new DataView(env.buffer, env.byteOffset + sigCountOffset, 4).getUint32(0), 2);

  const sigs = readEnvelopeSignatures(out.envelopeBase64, txXdr);
  assert.equal(sigs.length, 2);
  assert.deepEqual([...sigs[0].sig64], [...sponsorSig]);
  assert.deepEqual([...sigs[1].hint], [...user.publicKey.subarray(28)]);

  assert.equal(await verifyTxSignature({
    txXdrB64: txXdr, pub32: user.publicKey, sig64: sigs[1].sig64, netPassphrase: NET,
  }), true);
  assert.equal(await verifyTxSignature({
    txXdrB64: txXdr, pub32: user.publicKey, sig64: sigs[0].sig64, netPassphrase: NET,
  }), false);

  assert.equal(out.txHashHex.length, 64);
});

test('co-signing refuses an envelope for another transaction', async () => {
  const { txXdr } = buildSponsoredOpenTx({
    sponsorPub32: sponsor.publicKey, newPub32: user.publicKey, fee: FEE, seq: SEQ,
  });
  const otherTx = buildSponsoredOpenTx({
    sponsorPub32: sponsor.publicKey, newPub32: user.publicKey, fee: FEE, seq: SEQ + 1,
  }).txXdr;

  const fakeEnvelope = bytesToBase64(concat(
    u32Bytes(2), base64ToBytes(otherTx), u32Bytes(1),
    sponsor.publicKey.subarray(28), u32Bytes(64), new Uint8Array(64)));

  await assert.rejects(() => coSignSponsoredOpen({
    txXdrB64: txXdr,
    envelopeXdrB64: fakeEnvelope,
    seed32: seedOf(2),
    netPassphrase: NET,
    expectedPub32: user.publicKey,
  }), /does not carry the advertised tx_xdr/);
});

test('co-signing refuses a key that is not the sponsored account', async () => {
  const { txXdr } = buildSponsoredOpenTx({
    sponsorPub32: sponsor.publicKey, newPub32: user.publicKey, fee: FEE, seq: SEQ,
  });
  const tx = base64ToBytes(txXdr);
  const envelope = bytesToBase64(concat(
    u32Bytes(2), tx, u32Bytes(1),
    sponsor.publicKey.subarray(28), u32Bytes(64), new Uint8Array(64)));

  await assert.rejects(() => coSignSponsoredOpen({
    txXdrB64: txXdr,
    envelopeXdrB64: envelope,
    seed32: seedOf(9), // a different key
    netPassphrase: NET,
    expectedPub32: user.publicKey,
  }), /does not match the sponsored account/);
});

test('buildEnvelopeV1 round-trips the advertised tx body', () => {
  const ops = [
    opBegin(sponsor.publicKey, user.publicKey),
    opCreate(sponsor.publicKey, user.publicKey, ZERO_AMOUNT),
    opEnd(user.publicKey),
  ];
  const tx = buildTxV1(sponsor.publicKey, FEE, SEQ, ops);
  const env = buildEnvelopeV1(sponsor.publicKey, FEE, SEQ, ops,
    [{ pub32: sponsor.publicKey, sig64: new Uint8Array(64) }]);
  const decoded = bytesToBase64(tx);
  assert.equal(readEnvelopeSignatures(bytesToBase64(env), decoded).length, 1);
});
