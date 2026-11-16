// Transaction cards are untrusted E2E message text until this module verifies
// the exact hash against the configured NSAT indexer on the verified network.
// A sender-authored word like "confirmed" is never evidence: only `getTxDetail`
// and `verifyNetworkIdentity` can put a card in a finalized/failed state.
import {
  EXPECTED_NETWORK_ID, verifyNetworkIdentity, getConfirmation, getTxDetail,
} from './nsatClient.js';

const PREFIX = 'NSAT-TX/1\n';
const HASH_RE = /^[0-9a-f]{64}$/;
const ADDRESS_RE = /^G[A-Z2-7]{55}$/;
const AMOUNT_RE = /^(0|[1-9]\d*)$/;
// NativeAmount128 wire = signed int64 high limb + unsigned uint64 low limb.
const MAX_AMOUNT = (1n << 127n) - 1n;

function normalizeAmount(value) {
  if (typeof value !== 'string' || !AMOUNT_RE.test(value)) return null;
  try {
    const amount = BigInt(value);
    return amount <= MAX_AMOUNT ? amount.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Encode only public transaction context. `from` is derived from the verified
 * envelope sender, never copied from user-controlled JSON.
 */
export function createTransactionCardText({ hash, amount, from, to } = {}) {
  const txHash = typeof hash === 'string' ? hash.trim().toLowerCase() : '';
  const txAmount = normalizeAmount(amount);
  const sender = typeof from === 'string' ? from.trim().toUpperCase() : '';
  const recipient = typeof to === 'string' ? to.trim().toUpperCase() : '';
  if (!HASH_RE.test(txHash)) throw new Error('A transaction card needs a 64-character transaction hash.');
  if (!txAmount || txAmount === '0') throw new Error('A transaction card needs a positive integer amount.');
  if (!ADDRESS_RE.test(sender) || !ADDRESS_RE.test(recipient) || sender === recipient) {
    throw new Error('A transaction card needs distinct valid sender and recipient wallets.');
  }
  return `${PREFIX}${JSON.stringify({ hash: txHash, amount: txAmount, to: recipient })}`;
}

/**
 * Parse a card from a decrypted message. The sender address is authenticated by
 * openMessage(); the message payload cannot override it.
 */
export function parseTransactionCardText(text, authenticatedFrom) {
  if (typeof text !== 'string' || !text.startsWith(PREFIX)) return null;
  let value;
  try {
    value = JSON.parse(text.slice(PREFIX.length));
  } catch {
    return { kind: 'invalid', reason: 'This transaction card is malformed.' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'amount,hash,to') {
    return { kind: 'invalid', reason: 'This transaction card is malformed.' };
  }
  const hash = typeof value.hash === 'string' ? value.hash.toLowerCase() : '';
  const amount = normalizeAmount(value.amount);
  const from = typeof authenticatedFrom === 'string' ? authenticatedFrom.toUpperCase() : '';
  const to = typeof value.to === 'string' ? value.to.toUpperCase() : '';
  if (!HASH_RE.test(hash) || !amount || amount === '0'
      || !ADDRESS_RE.test(from) || !ADDRESS_RE.test(to) || from === to) {
    return { kind: 'invalid', reason: 'This transaction card has invalid fields.' };
  }
  return { kind: 'transaction-card', hash, amount, from, to };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validIndexerDetail(detail, hash) {
  if (!isPlainObject(detail) || String(detail.hash || '').toLowerCase() !== hash) return false;
  if (!Number.isSafeInteger(detail.ledger) || detail.ledger <= 0) return false;
  if (!Number.isSafeInteger(detail.close_time) || detail.close_time <= 0) return false;
  if (!ADDRESS_RE.test(String(detail.source || ''))) return false;
  if (typeof detail.success !== 'boolean') return false;
  if (typeof detail.result_code !== 'string' || !detail.result_code) return false;
  if (!Array.isArray(detail.ops) || detail.ops.length === 0) return false;
  return detail.ops.every((op) => isPlainObject(op)
    && Number.isSafeInteger(op.idx) && op.idx >= 0
    && typeof op.kind === 'string'
    && ADDRESS_RE.test(String(op.source || ''))
    && (op.destination === null || ADDRESS_RE.test(String(op.destination || '')))
    && (op.amount_stroops === null || normalizeAmount(String(op.amount_stroops)) !== null));
}

/**
 * Verify one card by its exact hash on the configured network.
 *
 * A transaction is `finalized` only when the indexer returns the same hash, its
 * success bit agrees with `txSUCCESS`, and at least one successful native
 * payment op matches the authenticated sender, requested amount, recipient and
 * this wallet's side of the conversation. A matching failed transaction is
 * `failed`; everything incomplete or mismatched is `unknown`.
 */
export async function verifyTransactionCard(card, {
  verifyNetwork = verifyNetworkIdentity,
  readConfirmation = getConfirmation,
  readDetail = getTxDetail,
} = {}) {
  const parsed = typeof card === 'string' ? null : card;
  if (!parsed || parsed.kind !== 'transaction-card') {
    return { status: 'unknown', reason: 'invalid_card' };
  }
  let network;
  try { network = await verifyNetwork(); }
  catch { return { status: 'unknown', reason: 'network_unavailable' }; }
  if (!network?.ok || network.network !== EXPECTED_NETWORK_ID) {
    return { status: 'unknown', reason: 'network_unverified' };
  }

  let verdict;
  try { verdict = await readConfirmation(parsed.hash); }
  catch { return { status: 'unknown', reason: 'confirmation_unavailable' }; }
  if (!isPlainObject(verdict) || String(verdict.hash || '').toLowerCase() !== parsed.hash
      || !['confirmed', 'failed', 'pending', 'unknown', 'not_found'].includes(verdict.status)) {
    return { status: 'unknown', reason: 'invalid_confirmation' };
  }
  if (verdict.status === 'pending') return { status: 'pending', hash: parsed.hash };
  if (verdict.status === 'unknown' || verdict.status === 'not_found') {
    return { status: 'unknown', reason: verdict.reason || verdict.status };
  }

  let detail;
  try { detail = await readDetail(parsed.hash); }
  catch { return { status: 'unknown', reason: 'indexer_unavailable' }; }
  if (!validIndexerDetail(detail, parsed.hash)) return { status: 'unknown', reason: 'invalid_indexer_record' };
  const expectedSuccess = verdict.status === 'confirmed';
  if (detail.success !== expectedSuccess
      || (Number.isSafeInteger(verdict.ledger) && detail.ledger !== verdict.ledger)
      || (typeof verdict.result_code === 'string' && detail.result_code !== verdict.result_code)) {
    return { status: 'unknown', reason: 'confirmation_detail_mismatch' };
  }

  const matching = detail.ops.some((op) => op.kind === 'payment'
    && op.asset === 'native'
    && op.source === parsed.from
    && op.destination === parsed.to
    && normalizeAmount(String(op.amount_stroops ?? '')) === parsed.amount);
  if (!matching) return { status: 'unknown', reason: 'transaction_mismatch' };

  if (detail.success && detail.result_code === 'txSUCCESS') {
    return {
      status: 'finalized', hash: parsed.hash, amount: parsed.amount,
      from: parsed.from, to: parsed.to, ledger: detail.ledger, closeTime: detail.close_time,
      network: network.network,
    };
  }
  if (!detail.success && detail.result_code !== 'txSUCCESS') {
    return {
      status: 'failed', hash: parsed.hash, amount: parsed.amount,
      from: parsed.from, to: parsed.to, ledger: detail.ledger, closeTime: detail.close_time,
      resultCode: detail.result_code, network: network.network,
    };
  }
  return { status: 'unknown', reason: 'inconsistent_indexer_result' };
}
