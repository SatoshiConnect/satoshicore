---
name: nsat-wallet-engine
description: Engineering rules for the reusable NSAT wallet engine — deterministic operations, exact integer monetary arithmetic, tx serialization, network identity verification, local signing, persistent wallet state, and cross-platform FFI. Use when implementing or modifying wallet core logic in satoshicore-web/lib (JS) or desktop/shielded Rust/Python layers, or when designing a shared native/WASM engine.
metadata:
  author: nsat
  version: "1.0.0"
---

# NSAT Wallet Engine

## When to use
Implementing, refactoring, or porting wallet core logic: transaction building/serialization,
deduction/addition arithmetic, sequence numbers, account ops, shielded state persistence,
or any FFI/binding layer.

## Files to inspect before changing anything
- JS engine: `satoshicore-web/lib/nsatCodec.js` (tx encoding), `satoshicore-web/lib/nsatWallet.js` (build+sign), `satoshicore-web/lib/nsatClient.js` (client SDK)
- Python desktop engine: `nsat-core/desktop/satoshicore-wallet/satoshicore_wallet/core.py`, `keystore.py`
- Rust shielded kernel: `nsat-core/shielded/rust/nsat-zk/`
- Protocol formats: `nsat-core/src/xdr/`, NSAT tx codec definitions referenced by nsatCodec.js
- Fee policy: `nsat-core/docs/NSAT-FEE-POLICY.md`

## Engineering rules
1. Money is exact integers (i64). Never use floats or JS `Number` > 2^53 for amounts; use BigInt end to end in JS.
2. One authoritative serialization: extend `nsatCodec.js` rather than adding a parallel codec; the desktop and web layers must produce byte-identical tx payloads.
3. Sender debit is exactly `amount + fee`; recipient receives exactly `amount`; fee goes to the ledger fee pool; never deduct fee from recipient amount.
4. Every tx carries the correct sequence number (`seq`) — fetch, use, increment after confirmation; never auto-broadcast blind retries (duplicate submission must be a decision, not a loop).
5. Network identity: verify `NETWORK_PASSPHRASE`/genesis root against `NSAT Mainnet ; October 2026 ; bc3098829fffc717` + `GDAILW75CM6I6OJHOM242PSB2NOHNBONZKOQCBTVSMHJTMYHU77LQB55` before signing or submitting to Mainnet; mismatch ⇒ hard abort. Devnet passphrases are isolated and disposable.
6. Local signing only: the engine signs with in-memory secret material; no server-side signing path may be added.
7. Reuse audited cryptographic code: prefer the existing Rust `nsat-zk` / core bindings over re-implementation. Do not rewrite production-tested crypto "for cleanliness."

## Mandatory validation (run after any engine change)
- `cd satoshicore-web && npm test -- --run` (or the repo's test runner) — SDK/gateway contract tests must stay green.
- Wallet suite vs devnet (see nsat-wallet-testing skill) focusing on: exact balances, rejected tx handling, seq-number handling, duplicate submission protection.
- Byte-identity check when both JS and Python engines emit the same tx: compare hex payloads in a fixture test.

## Acceptance criteria
- No float money paths; BigInt used end to end.
- New ops have deterministic tests (same inputs → same bytes/signature).
- Identity + fee gates enforced on every submit path.

## Evidence requirements
- Test names, exit codes, and tx-hex fixtures committed with the change.
