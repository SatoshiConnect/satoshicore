# CORE SECURITY AUDIT — NSAT Mainnet invariants (read-only this session)

Basis: nsat-core `9af27bad…` (branch `feature/shielded-core-integration`), Mainnet running Core v59, SHIELDED_V1 active since ledger 79251.

## What was verified this session (read-only)

| Invariant | Method | Result |
|---|---|---|
| Mainnet reachable and advancing via gateway | `:8790/api/v1/network/status` read-only | ledger 88,790, `core: ok`, identity exact ✔ PASS |
| Core RPC not publicly exposed | external probe to host IP :11626 | connection refused (000) ✔ PASS |
| Shielded activation state (79251) | source/history evidence — not re-probed this session | UNVERIFIED this session (no direct node access from web session) |

## Invariants previously verified (carried evidence, unchanged code)

- Monetary conservation (supply − burned fees = sum of account balances + shielded pool), no unexpected value creation — evidenced in the 2026‑10‑30 activation evidence file.
- Double-spend/seat-replay rejection; invalid Shielded proof rejection; nullifier uniqueness — covered by the devnet acceptance suites from the Shielded workstream.
- Quorum safety for the 3-validator topology — protocol-level property inherited from the consensus implementation; HISTORIC/UNVERIFIED this session.

## Fee-policy reconciliation (directive §7)
The documented fee pool vs burned-shielded-fees inconsistency was resolved in an
earlier session through source inspection: the collected fee model follows the
live config; NSAT-FEE-POLICY.md documents it. No consensus parameter was
touched this session, and no ledger mutation of any kind was performed.

## Honest classification
This session changed NOTHING consensus-critical, inspected no validator
runtime, and ran NO new Rust test suites (out of scope for the web session).
CORE-SECURITY-AUDIT therefore records carried PASS evidence, live read-only
probes, and explicitly lists what remains UNVERIFIED here rather than ing a fresh PASS.
