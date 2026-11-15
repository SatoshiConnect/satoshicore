// Transfer notices — the wallet's own record of a confirmed transfer.
//
// The indexer streams one row per account per committed transaction
// (`event: tx`, nsat-indexer/src/api.rs) *after* the ledger result is attached,
// and it writes that row for the source account and for the destination
// account. That is the only honest source for "this payment happened": the
// account sequence and the balance both move for other reasons, and a node's
// PENDING answer is not a ledger result. So both sides of a payment can be told
// from the same verdict instead of from "submitted".
//
// What this is NOT: a chat between two people, and not a push service. The
// notice is built locally from public row fields (no seed, no password, no
// signature) and never leaves the device. Telling the other party while their
// wallet is closed needs an authenticated backend plus a push service, which
// this build does not have — see docs/TRANSFER-NOTICES.md.

export const NOTICE_LIMIT = 20;

// A row is only announced while it is plausibly new to the person looking at
// the screen. When the wallet already knows a ledger height, anything at or
// below it was seen before. Before any history has loaded, fall back to the
// close time so a stream replay (`since=0`) cannot turn a page load into a burst
// of months-old payments.
export const NOTICE_WINDOW_SECONDS = 300;

export function shortAddress(address, head = 6, tail = 4) {
  const value = String(address || '').trim().toUpperCase();
  if (!value) return 'unknown address';
  // Chain data in this network includes account ids whose alphabet is wider than
  // base32, so the shape check is "a G… account id", not a strkey round-trip.
  if (!/^G[A-Z0-9]{55}$/.test(value)) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

// Exact integer text with thousands separators. Amounts are ledger integers;
// they are never parsed as floats on the way to the screen.
export function groupDigits(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return '';
  return text.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function noticeId(row) {
  const hash = String(row?.hash || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) return '';
  const index = Number(row?.op_index);
  return `${hash}:${Number.isInteger(index) && index >= 0 ? index : 0}`;
}

/** True when this row is new relative to what the wallet already showed. */
export function isNewTransfer(row, { baselineLedger = 0, startedAt = 0 } = {}) {
  const ledger = Number(row?.ledger);
  if (!Number.isFinite(ledger) || ledger <= 0) return false;
  const baseline = Number(baselineLedger);
  if (Number.isFinite(baseline) && baseline > 0) return ledger > baseline;
  const closedAt = Number(row?.close_time);
  const started = Number(startedAt);
  if (!Number.isFinite(closedAt) || closedAt <= 0) return false;
  if (!Number.isFinite(started) || started <= 0) return false;
  return closedAt * 1000 >= started - NOTICE_WINDOW_SECONDS * 1000;
}

// One notice per confirmed row. `direction` is the index's own word for this
// account's side of the row ("in", "out", "self"), and a failed row says so:
// for a payment, a failed operation moves the fee and nothing else.
export function buildTransferNotice(row, { limit = NOTICE_LIMIT } = {}) {
  const id = noticeId(row);
  if (!id) return null;
  const direction = ['in', 'out', 'self'].includes(row?.direction) ? row.direction : null;
  if (!direction) return null;

  // `amount` stays the exact integer the ledger reported; only the text is grouped.
  // The history endpoint reports the same figure twice (`amount` and raw
  // `amount_stroops`); the event stream carries only `amount_stroops`.
  const rawAmount = String(row?.amount ?? row?.amount_stroops ?? '').trim();
  const amount = /^\d+$/.test(rawAmount) ? rawAmount : '';
  const amountText = amount ? `${groupDigits(amount)} NSAT` : '';
  const counterparty = direction === 'self' ? '' : shortAddress(row?.counterparty);
  const ledger = Number(row?.ledger);
  const failed = row?.success === false;
  const resultCode = String(row?.result_code || '').trim();

  let title;
  if (direction === 'in') {
    title = failed ? `Incoming payment failed${resultCode ? ` (${resultCode})` : ''}` : `Received ${amountText || 'a payment'}`;
  } else if (direction === 'out') {
    title = failed ? `Payment failed${resultCode ? ` (${resultCode})` : ''}` : `Sent ${amountText || 'a payment'}`;
  } else {
    title = failed ? 'Wallet-to-wallet move failed' : `Moved ${amountText || 'funds'} between your own wallets`;
  }

  const parts = [];
  if (counterparty) parts.push(`${direction === 'in' ? 'from' : 'to'} ${counterparty}`);
  if (Number.isFinite(ledger) && ledger > 0) parts.push(`ledger ${ledger}`);
  // A failed row is not the same event as a paid one: say which fee moved.
  if (failed) parts.push('only the fee moved');
  const detail = parts.join(' · ');

  return {
    id,
    direction,
    failed,
    amount: amount || null,
    amountText,
    counterparty: counterparty || null,
    ledger: Number.isFinite(ledger) ? ledger : null,
    hash: String(row.hash).toLowerCase(),
    resultCode: resultCode || null,
    title,
    detail,
    // Spoken form for the live region, so the announcement is not just numbers.
    announcement: `${title}${counterparty ? `, ${direction === 'in' ? 'from' : 'to'} ${counterparty}` : ''}.`,
  };
}

/** Newest-first, de-duplicated, capped. */
export function addNotice(list, notice, { limit = NOTICE_LIMIT } = {}) {
  if (!notice) return list;
  if (list.some((entry) => entry.id === notice.id)) return list;
  return [notice, ...list].slice(0, limit);
}
