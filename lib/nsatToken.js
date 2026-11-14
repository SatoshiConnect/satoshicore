import { EXPECTED_NETWORK_ID } from './nsatClient';

// One source of truth for what NSAT *is*, so every page states the same
// numbers. Values are the live-verified Mainnet monetary policy
// (nsat-core/docs/NSAT-MONETARY-SPEC.md, MAINNET-IDENTITY-MANIFEST.md):
// Monetary constants confirmed from the node source: decimals 0 (the atomic
// unit IS one NSAT), fee 10 NSAT per operation, base reserve 100,000,000.
export const NSAT = {
  chain: 'SatoshiCore',
  symbol: 'NSAT',
  network: EXPECTED_NETWORK_ID,
  genesis: 'genesis bc3098829fffc717',
  decimals: 0,
  // Kept for internal checks only: the site deliberately never publishes the
  // total supply, so no page renders this value.
  maxSupply: '2100000000000000000000000',
  baseFee: 10,
  baseReserve: 100000000,
  // A CREATE (first funding of a new account) must cover 2× base reserve.
  createMinimum: 200000000,
  accountKey: 'Ed25519 · G… strkey (CRC16)',
  ledgerClose: 'seconds',
};

// Group an exact decimal string with thousands separators (string-only).
export function groupExact(value) {
  const s = String(value ?? '').trim();
  if (!/^\d+$/.test(s)) return 'n/a';
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Compact form for stat tiles only — the exact value is always shown next to
// it, so abbreviating here never hides a number that matters.
export function compactExact(value) {
  const s = String(value ?? '').trim();
  if (!/^\d+$/.test(s)) return 'n/a';
  if (s.length <= 6) return groupExact(s);
  const exp = s.length - 1;
  const head = `${s[0]}.${s.slice(1, 3)}`;
  return `${head} × 10^${exp}`;
}
