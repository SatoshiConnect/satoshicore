// Browser client for the SatoshiCore Web Wallet API Gateway.
// The gateway URL is public, non-sensitive configuration (NEXT_PUBLIC_*).
// This client never handles key material — signing happens in the wallet,
// and only already-signed envelopes are submitted here.

// Where the browser sends API calls.
//
// NEXT_PUBLIC_API_SAME_ORIGIN=1 means "talk to the origin this page was served
// from": /api/v1/* and /v1/* are proxied to the gateway and the indexer by the
// same Caddy that serves the page. That is how satoshicore.org is deployed —
// one domain, one certificate, no CORS preflight, no second hostname to keep
// alive. Without it, an explicit gateway base URL is required (offline mode is
// the fail-closed default for a bare static export such as GitHub Pages).
const SAME_ORIGIN = process.env.NEXT_PUBLIC_API_SAME_ORIGIN === '1';
const GATEWAY_URL = SAME_ORIGIN ? ''
  : (process.env.NEXT_PUBLIC_API_GATEWAY_URL || '').replace(/\/$/, '');

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
  return SAME_ORIGIN || GATEWAY_URL.length > 0;
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

// One read-only snapshot of the running node for the explorer dashboard:
// ledger head, peers, quorum agreement and the node's own metrics counters.
// The gateway serves its own recent reading when the node is briefly busy, and
// flags it with `stale: true` — the dashboard never treats it as fresh.
export async function getExplorerSnapshot() {
  return gatewayFetch('/api/v1/explorer/snapshot');
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

// Sponsorship policy for THIS network, read from the live core through the
// gateway: whether the deployment opened the flow, the ledger's protocol
// version, and the exact reserve a sponsor locks per account. The wallet
// gates the sponsored-account flow on `available` (see lib/nsatSponsorship.js).
export async function getSponsorshipPolicy() {
  return gatewayFetch('/api/v1/sponsorship/policy');
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

// Block explorer data comes from the read-only indexer, which is a separate
// process from the wallet API. It only answers GET, and never signs or submits
// anything, so the explorer is a pure reader of already-indexed chain history.
const INDEXER_URL = SAME_ORIGIN ? ''
  : (process.env.NEXT_PUBLIC_INDEXER_URL || '').replace(/\/$/, '');

export function isIndexerConfigured() {
  return SAME_ORIGIN || INDEXER_URL.length > 0;
}

async function indexerFetch(path) {
  if (!isIndexerConfigured()) throw new Error('indexer not configured');
  const res = await fetch(`${INDEXER_URL}${path}`, {
    signal: AbortSignal.timeout(10_000),
    headers: { Accept: 'application/json' }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `indexer error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// Indexer coverage: the ledger head it has processed, plus row counts.
export async function getIndexerHealth() {
  return indexerFetch('/v1/health');
}

// Indexed history for one account. Amounts arrive as both stroops (exact
// integer) and a pre-formatted NSAT string; the UI shows the formatted value
// and keeps the stroops for exact comparisons.
export async function getAccountHistory(accountId, limit = 50) {
  return indexerFetch(
    `/v1/accounts/${encodeURIComponent(accountId)}/transactions?limit=${limit}`
  );
}

// Full detail for one transaction hash, including its operations.
export async function getTxDetail(hash) {
  return indexerFetch(`/v1/tx/${encodeURIComponent(hash)}`);
}

// The ledger's verdict for EXACTLY this transaction hash.
//
// This is the only thing that may call a transfer confirmed: the response is
// built from the transaction's own result in the closed ledger
// (`txSUCCESS` / `txFAILED` / a specific failure code), with the ledger number,
// the ledger hash, the evidence source and the ledger close time. `status` is
// one of:
//   confirmed | failed   terminal, exact ledger result
//   pending              not decided yet (may still be in the ledger being closed)
//   unknown              the index cannot decide (behind, or history gap)
//   not_found            the index is caught up and the hash is not in it
//
// Account sequence numbers and balance deltas are deliberately NOT inputs: a
// later transfer from the same account can move both without this hash ever
// being applied, which is how a wallet ends up confirming a payment that never
// happened.
export async function getConfirmation(hash, submittedAt) {
  const normalized = String(hash || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error('invalid transaction hash');
  }
  const query = submittedAt ? `?submitted_at=${encodeURIComponent(submittedAt)}` : '';
  return indexerFetch(`/v1/confirmations/${normalized}${query}`);
}

// Poll the exact-hash verdict with bounded backoff until it is terminal or the
// deadline passes. `submitted_at` lets the index distinguish "too early to
// tell" from "this hash is not in any ledger it has indexed".
export async function waitForConfirmation(hash, { submittedAt, timeoutMs = 90_000, onUpdate } = {}) {
  const deadline = Date.now() + timeoutMs;
  let delay = 400;
  let attempts = 0;
  let last = null;
  while (Date.now() < deadline) {
    attempts += 1;
    try {
      const verdict = await getConfirmation(hash, submittedAt);
      last = verdict;
      onUpdate?.(verdict);
      if (verdict.status === 'confirmed' || verdict.status === 'failed') return verdict;
      // `not_found` is terminal for this attempt: the index is caught up and
      // the hash is not in it.
      if (verdict.status === 'not_found') return verdict;
      // `unknown` means the index cannot decide; three tries is enough before
      // we report that honestly instead of hanging the modal.
      if (verdict.status === 'unknown' && attempts >= 3) return verdict;
      delay = Math.min(2000, Math.round(delay * 1.4));
    } catch (error) {
      // A 429 is the gateway's rate limit: back off harder instead of
      // hammering it. Any other failure is retried at a bounded delay.
      delay = error?.status === 429 ? Math.min(5000, delay * 3) : Math.min(3000, delay + 500);
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return last ?? { hash, status: 'pending', reason: 'client_timeout' };
}

// Server-sent events for one account's confirmed rows, used to refresh a
// recipient balance as soon as the ledger commits.
//
// `since` is the last ledger the client already knows about; the stream replays
// from there, so a reconnect after a dropped connection loses nothing. Returns
// null when no indexer is configured, and the caller then stays on bounded
// polling.
export function accountEventsUrl(account, since = 0) {
  if (!isIndexerConfigured()) return null;
  return `${INDEXER_URL}/v1/accounts/${encodeURIComponent(account)}/events?since=${encodeURIComponent(since)}`;
}

// Format an exact balance string with thousands separators using only
// string/BigInt-safe operations (never float).
export function formatExactBalance(balance128) {
  const s = String(balance128 ?? '').trim();
  if (!/^\d+$/.test(s)) return 'n/a';
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
