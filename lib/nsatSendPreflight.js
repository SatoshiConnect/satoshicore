// nsatSendPreflight.js — shared send gate for the Web wallet.
// Mirror of nsat-core docs/wallet-ux/prototype/nsat-ux-core.mjs (same reason
// strings on every platform). Pure logic, BigInt money, no DOM, no network.
// The UI renders `block.reason` next to the disabled button instead of
// hand-writing disable logic (NSAT-WALLET-BUTTON-STATES.md).

export const ACCOUNT_RE = /^G[A-Z2-7]{55}$/;

export function cleanAmount(raw) {
  return String(raw ?? '').replace(/[,_ ]/g, '');
}

export function validateAmount(raw) {
  const a = cleanAmount(raw);
  if (a === '') return { ok: false, reason: 'Enter an amount — exact integers only.' };
  if (!/^\d+$/.test(a)) return { ok: false, reason: 'NSAT has no decimals — exact integers only.' };
  let v;
  try { v = BigInt(a); } catch { return { ok: false, reason: 'NSAT has no decimals — exact integers only.' }; }
  if (v <= 0n) return { ok: false, reason: 'Enter an amount — exact integers only.' };
  return { ok: true, value: v };
}

export function validateRecipient(dest, ownAddress) {
  const d = String(dest ?? '').trim();
  // Nothing typed yet is a hint, not an error: the UI renders this reason in
  // neutral type until the field has content.
  if (d === '') return { ok: false, reason: 'Enter the recipient’s G… address.' };
  if (!ACCOUNT_RE.test(d)) return { ok: false, reason: 'Address format is invalid.' };
  if (ownAddress && d === ownAddress) return { ok: false, reason: 'Recipient is your own address.' };
  return { ok: true };
}

/** Largest sendable amount of a funded account: balance − fee (BigInt). */
export function maxSendable(balance, fee) {
  const b = BigInt(cleanAmount(balance ?? '0') || '0');
  const f = BigInt(cleanAmount(String(fee ?? '0')));
  return b > f ? b - f : 0n;
}

/**
 * One preflight for the Send page. state: { active, netOk, dest, amount,
 * balance (string|null), fee, createDest, baseReserve }.
 * Returns { ok, block: null | { kind, reason }, warn: null | { reason } }.
 * A too-small CREATE amount is a warning (the chain also enforces it).
 */
export function sendPreflight(state) {
  if (!state.active) return { ok: false, block: { kind: 'locked', reason: 'Unlock the wallet to send.' }, warn: null };
  if (!state.netOk) return { ok: false, block: { kind: 'network', reason: 'Network identity not verified — sending disabled until the exact expected Mainnet identity is verified.' }, warn: null };

  const rec = validateRecipient(state.dest, state.active.pubkey);
  if (!rec.ok) return { ok: false, block: { kind: 'recipient', reason: rec.reason }, warn: null };

  const amt = validateAmount(state.amount);
  if (!amt.ok) return { ok: false, block: { kind: 'amount', reason: amt.reason }, warn: null };

  const fee = BigInt(state.fee ?? '0');
  const total = amt.value + fee;

  if (state.createDest && state.baseReserve > 0 && amt.value < BigInt(2 * state.baseReserve)) {
    return {
      ok: true, block: null,
      // Unit wording: NSAT is the integer unit (verified: 1 NSAT = integer 1;
      // docs/NSAT-FEE-POLICY.md "10 NSAT"). We do not invent a "stroops" scale.
      warn: { kind: 'create', reason: `CREATE starting balance must be ≥ ${fmtGroup((BigInt(2 * state.baseReserve)).toString())} NSAT (2× base reserve) — the chain charges the fee and fails the operation.` },
    };
  }

  const bal = state.balance == null ? null : BigInt(state.balance);
  if (bal !== null && total > bal) {
    const mx = maxSendable(bal, fee);
    const nudge = mx > 0n ? ' Use Max?' : '';
    return { ok: false, block: { kind: 'insufficient', reason: `Insufficient balance — ${fmtGroup(bal.toString())} NSAT available; amount + fee = ${fmtGroup(total.toString())} exceeds it.${nudge}` }, warn: null };
  }

  return { ok: true, block: null, warn: null };
}

const GROUP_RE = /\B(?=(\d{3})+(?!\d))/g;
/** Group an exact integer STRING (never a float). */
export function fmtGroup(s) {
  const str = String(s ?? '');
  if (!/^-?\d+$/.test(str)) return str;
  const neg = str.startsWith('-');
  return (neg ? '-' : '') + (neg ? str.slice(1) : str).replace(GROUP_RE, ',');
}
