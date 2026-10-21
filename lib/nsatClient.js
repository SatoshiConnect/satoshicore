// Browser client for the SatoshiCore Web Wallet API Gateway.
// The gateway URL is public, non-sensitive configuration (NEXT_PUBLIC_*).
// This client never handles key material — signing happens in the wallet,
// and only already-signed envelopes are submitted here.

const GATEWAY_URL = (process.env.NEXT_PUBLIC_API_GATEWAY_URL || '').replace(/\/$/, '');

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
    throw err;
  }
  return body;
}

// Read-only chain status from the nsat-core node via the gateway.
export async function getChainInfo() {
  return gatewayFetch('/api/v1/chain/info');
}

// Submit an ALREADY-SIGNED transaction envelope (base64 XDR).
export async function submitSignedTransaction(envelopeXdr) {
  return gatewayFetch('/api/v1/tx', {
    method: 'POST',
    body: JSON.stringify({ envelope_xdr: envelopeXdr })
  });
}
