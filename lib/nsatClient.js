// Browser client for the SatoshiCore Web Wallet API Gateway.
// The gateway URL is public, non-sensitive configuration (NEXT_PUBLIC_*).
// This client never handles key material — signing happens in the wallet,
// and only already-signed envelopes are submitted here.

const GATEWAY_URL = (process.env.NEXT_PUBLIC_API_GATEWAY_URL || '').replace(/\/$/, '');

// Expected network. IMPORTANT (privacy/security): this is a value comparison
// the UI performs on every connect; a mismatch MUST be surfaced to the user
// before any wallet action, not silently ignored.
export const EXPECTED_NETWORK_NAME = process.env.NEXT_PUBLIC_NSAT_NETWORK_NAME || 'NSAT';

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

// Submit an ALREADY-SIGNED transaction envelope (base64 XDR).
export async function submitSignedTransaction(envelopeXdr) {
  return gatewayFetch('/api/v1/tx', {
    method: 'POST',
    body: JSON.stringify({ envelope_xdr: envelopeXdr })
  });
}

// Returns { ok, network, ledger, reason } — a connect check the wallet runs
// before enabling any balance or send UI.
export async function verifyNetworkIdentity() {
  try {
    const st = await getNetworkStatus();
    const network = st.network || '';
    const ok = network === EXPECTED_NETWORK_NAME ||
      (network.startsWith(`${EXPECTED_NETWORK_NAME} `) || network.startsWith('NSAT'));
    return { ok, network, ledger: st.ledger, core: st.core,
      reason: ok ? null : `expected "${EXPECTED_NETWORK_NAME}", got "${network}"` };
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
