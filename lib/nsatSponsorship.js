// NSAT sponsored account opening — wallet-side rules.
//
// A sponsored account is opened by a transaction that (1) begins
// sponsorship from an operator-held sponsor account, (2) creates the new
// account with a zero starting balance, and (3) ends sponsorship from the
// new account. Because the END operation is sourced from the NEW account,
// that account must sign the transaction too — so the operator's envelope
// arrives partially signed and this module adds the user's signature.
//
// Everything here is deliberately strict about what the user signs:
// verifySponsoredOpenTx() accepts exactly one transaction shape and refuses
// anything else, so a malformed or substituted operator payload cannot make
// the wallet authorize a drain.
//
// The feature is gated on Core protocol 30 (NSAT reserve sponsorship). Until
// the network's ledger protocol version reaches 30 the core rejects both
// sponsorship operations, so the wallet must not offer the flow.

import {
  ENVELOPE_TYPE_TX, buildTxV1, buildEnvelopeV1, decodeG, encodeG,
  ed25519Keypair, ed25519Sign, ed25519Verify, opaqueBytes, u32Bytes,
  concat, bytesToBase64, base64ToBytes, sha256, bytesToHex, payloadSignatureInput,
} from './nsatCodec.js';

export const SPONSORSHIP_PROTOCOL_VERSION = 30;

// Reserve units: an account entry is 2 base reserves (the account itself and
// its sponsorship relation). Same value the core charges in
// CreateAccountOpFrame / SponsorshipUtils.
export const ACCOUNT_RESERVE_UNITS = 2n;

// { available, reason } — the single gate the UI and the request path share.
export function sponsorshipGate({ protocolVersion, policyEnabled }) {
  if (policyEnabled === false) {
    return { available: false, reason: 'sponsorship is not open on this deployment' };
  }
  const pv = Number(protocolVersion);
  if (!Number.isSafeInteger(pv) || pv <= 0) {
    return { available: false, reason: 'network protocol version unknown' };
  }
  if (pv < SPONSORSHIP_PROTOCOL_VERSION) {
    return {
      available: false,
      reason: `sponsorship requires Core protocol ${SPONSORSHIP_PROTOCOL_VERSION}; `
        + `this network is on ${pv}`,
    };
  }
  return { available: true, reason: null };
}

// Exact reserve a sponsor locks for one new account, in stroops.
export function reserveForNewAccount(baseReserve) {
  const br = BigInt(baseReserve);
  if (br <= 0n) throw new Error('baseReserve must be positive');
  return br * ACCOUNT_RESERVE_UNITS;
}

// ---------------------------------------------------------------------------
// Operator payload verification
// ---------------------------------------------------------------------------
// tx_xdr is the base64 TransactionV1 body that the sponsor signed.
// envelope_xdr is the sponsor-signed TransactionEnvelope (TX).
//
// The accepted transaction is exactly:
//   source = sponsor, opex 0: BEGIN(sponsored = user)
//                     op 1: CREATE_ACCOUNT(dest = user, amount = 0)
//                     op 2: END(source = user)
export function verifySponsoredOpenTx(txXdrB64, expectedPub32) {
  let tx;
  try {
    tx = base64ToBytes(txXdrB64);
  } catch {
    return { ok: false, reason: 'tx_xdr is not valid base64' };
  }
  const need = 4 + 32 + 4 + 8 + 4 + 4 + 4 + 80 + 96 + 44 + 4;
  if (tx.length !== need) {
    return { ok: false, reason: `unexpected transaction size ${tx.length}` };
  }

  const rd = new Reader(tx);
  const srcTag = rd.u32();
  if (srcTag !== 0) return { ok: false, reason: 'sourceAccount is not an ed25519 key' };
  const sponsorPub32 = rd.bytes(32);
  const fee = rd.u32();
  const seq = rd.u64();
  if (rd.u32() !== 0) return { ok: false, reason: 'transaction preconditions are not empty' };
  if (rd.u32() !== 0) return { ok: false, reason: 'transaction memo is not empty' };
  const opCount = rd.u32();
  if (opCount !== 3) return { ok: false, reason: `expected 3 operations, got ${opCount}` };

  // BEGIN
  const op0 = rd.op();
  if (op0.present !== 1 || op0.sourceTag !== 0) {
    return { ok: false, reason: 'BEGIN operation source must be a present ed25519 key' };
  }
  if (op0.type !== 16) return { ok: false, reason: 'first operation is not BEGIN_SPONSORING' };
  if (!sameBytes(op0.src32, sponsorPub32)) {
    return { ok: false, reason: 'BEGIN is not signed for by the transaction source' };
  }
  if (!sameBytes(op0.sponsored32, expectedPub32)) {
    return { ok: false, reason: 'BEGIN sponsors a different account' };
  }

  // CREATE_ACCOUNT
  const op1 = rd.op();
  if (op1.present !== 1 || op1.sourceTag !== 0) {
    return { ok: false, reason: 'CREATE_ACCOUNT source must be a present ed25519 key' };
  }
  if (op1.type !== 0) return { ok: false, reason: 'second operation is not CREATE_ACCOUNT' };
  if (!sameBytes(op1.dest32, expectedPub32)) {
    return { ok: false, reason: 'CREATE_ACCOUNT creates a different account' };
  }
  if (op1.amountHi !== 0n || op1.amountLo !== 0n) {
    return {
      ok: false,
      reason: 'CREATE_ACCOUNT must start at 0 NSAT: sponsorship covers the reserve, not a gift',
    };
  }

  // END
  const op2 = rd.op();
  if (op2.present !== 1 || op2.sourceTag !== 0) {
    return { ok: false, reason: 'END operation source must be a present ed25519 key' };
  }
  if (op2.type !== 17) return { ok: false, reason: 'third operation is not END_SPONSORING' };
  if (!sameBytes(op2.src32, expectedPub32)) {
    return { ok: false, reason: 'END is not sourced from your account' };
  }

  if (rd.u32() !== 0) return { ok: false, reason: 'transaction extension is not empty' };
  if (!rd.done()) return { ok: false, reason: 'trailing bytes after the transaction' };

  return { ok: true, reason: null, sponsorG: encodeG(sponsorPub32), fee, seq };
}

// Extract the DecoratedSignatures already present in a sponsor-signed
// TransactionEnvelope for the given transaction body.
export function readEnvelopeSignatures(envelopeXdrB64, txXdrB64) {
  const env = base64ToBytes(envelopeXdrB64);
  const tx = base64ToBytes(txXdrB64);
  const rd = new Reader(env);
  if (rd.u32() !== ENVELOPE_TYPE_TX) throw new Error('envelope is not a TransactionV1 envelope');
  const body = rd.bytes(tx.length);
  if (!sameBytes(body, tx)) throw new Error('envelope does not carry the advertised tx_xdr');
  const n = rd.u32();
  const sigs = [];
  for (let i = 0; i < n; i++) {
    sigs.push({ hint: rd.bytes(4), sig64: rd.opaque() });
  }
  if (!rd.done()) throw new Error('trailing bytes after the envelope');
  return sigs;
}

// Add the new account's signature to the sponsor-signed envelope and return
// the submission-ready envelope. The signed bytes are recomputed locally from
// tx_xdr, so the wallet never authorizes bytes it has not inspected.
export async function coSignSponsoredOpen({
  txXdrB64, envelopeXdrB64, seed32, netPassphrase, expectedPub32,
}) {
  const check = verifySponsoredOpenTx(txXdrB64, expectedPub32);
  if (!check.ok) throw new Error(`refusing to sign: ${check.reason}`);

  const tx = base64ToBytes(txXdrB64);
  const prior = readEnvelopeSignatures(envelopeXdrB64, txXdrB64);
  if (prior.length !== 1) {
    throw new Error(`expected exactly 1 sponsor signature, got ${prior.length}`);
  }

  const netId = await sha256(new TextEncoder().encode(netPassphrase));
  const payload = payloadSignatureInput(netId, tx);
  const sig64 = ed25519Sign(seed32, await sha256(payload));

  const kp = await ed25519Keypair(seed32);
  if (!sameBytes(kp.pub32, expectedPub32)) {
    throw new Error('the wallet key does not match the sponsored account');
  }

  const env = concat(u32Bytes(ENVELOPE_TYPE_TX), tx, u32Bytes(2),
    concat(prior[0].hint, opaqueBytes(prior[0].sig64)),
    concat(kp.pub32.subarray(28), opaqueBytes(sig64)));
  return {
    envelopeBase64: bytesToBase64(env),
    txHashHex: bytesToHex(await sha256(tx)),
  };
}

// Verify a signature over a TransactionV1 payload (used by tests and by the
// operator tool's self-check).
export async function verifyTxSignature({ txXdrB64, pub32, sig64, netPassphrase }) {
  const netId = await sha256(new TextEncoder().encode(netPassphrase));
  const payload = payloadSignatureInput(netId, base64ToBytes(txXdrB64));
  return ed25519Verify(sig64, await sha256(payload), pub32);
}

// Build the unsiged transaction for the sponsored open (operator side).
export function buildSponsoredOpenTx({
  sponsorPub32, newPub32, fee, seq,
}) {
  const ops = [
    opBegin(sponsorPub32, newPub32),
    opCreate(sponsorPub32, newPub32),
    opEnd(newPub32),
  ];
  return { txXdr: bytesToBase64(buildTxV1(sponsorPub32, fee, seq, ops)) };
}

// Operator side: build AND sign the sponsored open with the sponsor key.
// Returns the transaction body plus a single-signature envelope that the new
// account completes with coSignSponsoredOpen(). The sponsor seed stays in
// this process (services/sponsor/sponsor-open.js loads it from a 0600 file).
export async function signSponsoredOpen({
  sponsorSeed32, newPub32, fee, seq, netPassphrase,
}) {
  const sponsorKp = await ed25519Keypair(sponsorSeed32);
  const ops = [
    opBegin(sponsorKp.pub32, newPub32),
    opCreate(sponsorKp.pub32, newPub32),
    opEnd(newPub32),
  ];
  const tx = buildTxV1(sponsorKp.pub32, fee, seq, ops);
  const netId = await sha256(new TextEncoder().encode(netPassphrase));
  const digest = await sha256(payloadSignatureInput(netId, tx));
  const sig64 = ed25519Sign(sponsorSeed32, digest);
  const envelope = concat(u32Bytes(ENVELOPE_TYPE_TX), tx, u32Bytes(1),
    concat(sponsorKp.pub32.subarray(28), opaqueBytes(sig64)));
  return {
    txXdr: bytesToBase64(tx),
    envelopeXdr: bytesToBase64(envelope),
    sponsorG: encodeG(sponsorKp.pub32),
  };
}

// ---------------------------------------------------------------------------
// minimal XDR readers for the fixed sponsored-open shape
// ---------------------------------------------------------------------------
class Reader {
  constructor(buf) { this.buf = buf; this.off = 0; }
  need(n) {
    if (this.off + n > this.buf.length) throw new Error('truncated XDR');
  }
  u32() { this.need(4); const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.off, 4).getUint32(0); this.off += 4; return v; }
  u64() { this.need(8); const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.off, 8).getBigUint64(0); this.off += 8; return v; }
  bytes(n) { this.need(n); const v = this.buf.slice(this.off, this.off + n); this.off += n; return v; }
  opaque() {
    const n = this.u32();
    const v = this.bytes(n);
    const pad = (4 - (n % 4)) % 4;
    this.bytes(pad);
    return v;
  }
  accountId() {
    if (this.u32() !== 0) throw new Error('AccountID is not ed25519');
    return this.bytes(32);
  }
  op() {
    const present = this.u32();
    if (present !== 1) throw new Error('operation sourceAccount is absent');
    const sourceTag = this.u32();
    const src32 = this.bytes(32);
    const type = this.u32();
    const out = { present, sourceTag, src32, type };
    if (type === 16) out.sponsored32 = this.accountId();
    else if (type === 0) {
      out.dest32 = this.accountId();
      const hi = new DataView(this.buf.buffer, this.buf.byteOffset + this.off, 8).getBigInt64(0);
      this.off += 8;
      out.amountHi = hi;
      out.amountLo = this.u64();
    }
    return out;
  }
  done() { return this.off === this.buf.length; }
}

function opBegin(sponsorPub32, newPub32) {
  return concat(u32Bytes(1), accountId(sponsorPub32), u32Bytes(16), accountId(newPub32));
}
function opCreate(sponsorPub32, newPub32) {
  return concat(u32Bytes(1), accountId(sponsorPub32), u32Bytes(0),
    accountId(newPub32), new Uint8Array(16));
}
function opEnd(newPub32) {
  return concat(u32Bytes(1), accountId(newPub32), u32Bytes(17));
}
function accountId(pub32) { return concat(u32Bytes(0), pub32); }

function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export { decodeG, encodeG, buildEnvelopeV1 };
