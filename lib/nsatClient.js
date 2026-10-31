// Browser client for the SatoshiCore Web Wallet API Gateway.
// The gateway URL is public, non-sensitive configuration (NEXT_PUBLIC_*).
// This client never handles key material — signing happens in the wallet,
// and only already-signed envelopes are submitted here.

const GATEWAY_URL = (process.env.NEXT_PUBLIC_API_GATEWAY_URL || '').replace(/\/$/, '');

// Expected network identity: the COMPLETE, byte-exact verified NSAT Mainnet
// passphrase (live-validator evidence: nsat-core MAINNET-ACTIVATION-20261025,
// MAINNET-OPS-REPORT-20261025-PHASE2 "echoed live by all nodes").
//
// Configuration contract (fail closed):
//  - Set NEXT_PUBLIC_NSAT_NETWORK_ID at build time to override (e.g. a
//    disposable devnet identity for tests). The value must be the FULL
//    passphrase — short names ("NSAT", "NSAT Mainnet") or prefix matches are
//    never accepted.
//  - An explicitly blank override degrades to a value that matches nothing.
const FULL_MAINNET_IDENTITY = 'NSAT Mainnet ; October 2026 ; bc3098829fffc717';
export const EXPECTED_NETWORK_ID =
  process.env.NEXT_PUBLIC_NSAT_NETWORK_ID === undefined
    ? FULL_MAINNET_IDENTITY
    : process.env.NEXT_PUBLIC_NSAT_NETWORK_ID.trim() || '__MISCONFIGURED_NO_NETWORK_ID__';

export function isGatewayConfigured() {
  return GATEWAY_URL.length > 0;
}

async function gatewayFetch(path, options = {}) {
  if (!isGatewayConfigured()) throw new Error('gateway not configured');
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    ...options,
    signal: AbortSignal.timeout(10_000),
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `gateway error ${res.status}`);
    err.status = res.status;
    err.busy = body.status === 'busy';
    throw err;
  }
  return body;
}

// Read-only chain status from the nsat-core node via the gateway.
export async function getChainInfo() {
  return gatewayFetch('/api/v1/chain/info');
}

// Gateway+core liveness, current ledger, and the network name the gateway
// reports — used for the network-identity verification the wallet shows.
export async function getNetworkStatus() {
  return gatewayFetch('/api/v1/network/status');
}

// Read-only account lookup (exact 128-bit balance + sequence). Response bodies
// are plain decimal strings for treasury-scale accounts; formatting is done
// with BigInt only — this wallet never uses floats for money.
export async function getAccount(accountId) {
  return gatewayFetch(`/api/v1/account?acc=${encodeURIComponent(accountId)}`);
}

// Fee estimation: the network's current base fee (stroops), read from the
// live ledger header the gateway proxies. Exact integer; no fee application,
// no rounding — the network runs a single base fee (currently 10).
export async function estimateFee() {
  const info = await getChainInfo();
  const baseFee = info?.info?.ledger?.baseFee;
  if (!Number.isSafeInteger(baseFee) || baseFee <= 0) {
    const err = new Error('no baseFee in chain info');
    err.status = info?.status;
    throw err;
  }
  return baseFee;
}

// Submit an ALREADY-SIGNED transaction envelope (base64 XDR).
export async function submitSignedTransaction(envelopeXdr) {
  return gatewayFetch('/api/v1/tx', {
    method: 'POST',
    body: JSON.stringify({ envelope_xdr: envelopeXdr })
  });
}

// Returns { ok, network, ledger, reason } — a connect check the wallet runs
// before enabling any balance or send UI.
//
// STRICT identity verification (fail closed):
//  - `network` MUST equal EXPECTED_NETWORK_ID byte-for-byte. No startsWith,
//    no prefix matching, no case folding, no trimmed comparisons.
//  - If the gateway is unreachable, malformed, or the reported identity is
//    absent/non-string/blank, verification FAILS (a devnet cannot masquerade
//    as Mainnet; "NSAT" or "NSAT Mainnet" alone is never accepted).
export async function verifyNetworkIdentity() {
  if (!EXPECTED_NETWORK_ID || EXPECTED_NETWORK_ID.startsWith('__MISCONFIGURED')) {
    return { ok: false, network: null, ledger: null,
      reason: 'wallet connected to no network: network identity is required '
        + 'configuration (NEXT_PUBLIC_NSAT_NETWORK_ID)' };
  }
  try {
    const st = await getNetworkStatus();
    const network = typeof st.network === 'string' ? st.network : '';
    if (!network) {
      return { ok: false, network: st.network ?? null, ledger: st.ledger ?? null,
        reason: 'gateway did not report the on-chain network identity' };
    }
    const ok = network === EXPECTED_NETWORK_ID;
    return { ok, network, ledger: st.ledger, core: st.core,
      reason: ok ? null : `expected "${EXPECTED_NETWORK_ID}", got "${network}"` };
  } catch (e) {
    return { ok: false, network: null, ledger: null,
      reason: e.busy ? 'core ledger busy — try again' : 'gateway unreachable' };
  }
}

// Format an exact balance string with thousands separators using only
// string/BigInt-safe operations (never float).
export function formatExactBalance(balance128) {
  const s = String(balance128 ?? '').trim();
  if (!/^\d+$/.test(s)) return 'n/a';
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
