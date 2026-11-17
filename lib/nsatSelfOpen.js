// NSAT self-open — a brand-new key opens its own account, for free.
//
// Core V_16 accepts exactly one transaction shape with no fee and no source
// account: a single CREATE_ACCOUNT of 0 NSAT whose transaction source, op
// source and destination are the same key. Nothing is charged (there is no
// account to charge) and nothing is locked (V_15 already dropped the account
// entry reserve), so the account exists at a zero balance without a sponsor
// and without a deposit.
//
// This is the only transaction the wallet can sign for an address that has no
// account yet: every other operation needs an existing account as its source.

import {
  ENVELOPE_TYPE_TX, buildTxV1, buildEnvelopeV1, ed25519Keypair, ed25519Sign,
  u32Bytes, concat, bytesToBase64, sha256, bytesToHex, payloadSignatureInput,
  opCreateAccount, encodeG,
} from './nsatCodec.js';

// First ledger version that accepts a fee-free self-open (Core V_16).
export const SELF_OPEN_PROTOCOL_VERSION = 16;

// { available, reason } — the single gate the UI and the request path share.
// Unknown versions fail closed: on anything older this transaction is refused
// with txINSUFFICIENT_FEE / txNO_ACCOUNT.
export function selfOpenGate({ protocolVersion }) {
  const pv = Number(protocolVersion);
  if (!Number.isSafeInteger(pv) || pv <= 0) {
    return { available: false, reason: 'network protocol version unknown' };
  }
  if (pv < SELF_OPEN_PROTOCOL_VERSION) {
    return {
      available: false,
      reason: `opening an account for free requires Core protocol ${SELF_OPEN_PROTOCOL_VERSION}; `
        + `this network is on ${pv}`,
    };
  }
  return { available: true, reason: null };
}

// Build and sign the self-open transaction with the wallet's own key.
// Returns { envelopeBase64, txHashHex, pubkeyG }. No seed is returned and no
// seed leaves this function.
export async function buildSelfOpenTx({ seed32, netPassphrase }) {
  const kp = await ed25519Keypair(seed32);
  const pub32 = kp.pub32;
  // One operation: create THIS key's account, starting balance exactly 0.
  const op = opCreateAccount(pub32, pub32, 0n);
  // fee 0, sequence 0: no account is charged and none has a sequence number
  // to advance yet — the ledger's V_16 rule requires both to be zero here.
  const tx = buildTxV1(pub32, 0, 0, [op]);
  const netId = await sha256(new TextEncoder().encode(netPassphrase));
  const sig64 = ed25519Sign(seed32, await sha256(payloadSignatureInput(netId, tx)));
  const envelope = buildEnvelopeV1(pub32, 0, 0, [op], [{ pub32, sig64 }]);
  return {
    envelopeBase64: bytesToBase64(envelope),
    txHashHex: bytesToHex(await sha256(tx)),
    pubkeyG: encodeG(pub32),
  };
}

// Kept so callers that only need the wire identity of the envelope do not
// duplicate the codec layout.
export { ENVELOPE_TYPE_TX, u32Bytes, concat };
