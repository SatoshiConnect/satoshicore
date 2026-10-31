---
name: nsat-wallet-testing
description: Evidence-backed acceptance testing for the NSAT wallet — wallet create/import/lock/unlock, encryption, backup/restore, balances, transparent send/receive, fee estimation, rejections, ledger finalization, shielded deposit/transfer/withdrawal, nullifier replay rejection, interrupted writes, restart recovery, corrupted storage, secret leakage. Use before any completion claim; all mutating tests run on isolated disposable devnet only.
metadata:
  author: nsat
  version: "1.0.0"
---

# NSAT Wallet Testing

## When to use
Verifying wallet features, closing defects, running acceptance regressions, or
producing the evidence for WALLET-E2E-TEST-RESULTS.md.

## Test environment rules
1. Mutating transactions run against an isolated disposable devnet only (e.g. `scripts/wallet-devnet.sh` in nsat-core; fresh `/tmp` state; fee per policy = 10). NEVER against live Mainnet; never reuse the identity of any real network.
2. Read-only verification (balances/history/status) may target live Mainnet endpoints (ports 11626/11628/11630, `/info`, account queries) — always read-only.
3. Do not use production ledger data as test fixtures; do not move Treasury funds.

## Coverage checklist (each item = named test + evidence)
A. Accounts: create, import, unlock/lock, export encrypted backup, restore (incl. corrupted-file rejection), balances.
B. Transparent: receive, send exact amounts (`amount+fee` debit, fee=network value 10), fee estimation, history, status finalization, rejected tx (insufficient balance / bad seq), duplicate-submission decision path.
C. Shielded (devnet): deposit, private transfer, withdrawal, conservation reconciliation, nullifier replay rejection, restart/recovery, interrupted-write rollback (journal consistency), proof rejection on invalid input.
D. Robustness: devnet restart mid-suite, network failure handling (node unreachable → clear error, no silent retry of signed tx), connection recovery.
E. Security: no secret in logs elsewhere; grep changed files for S-strkey material; backup restore tamper test.
F. UI/a11y (web): wallet page renders with clear network identity badge, fee preview, error and pending states; keyboard navigable (see web-design-guidelines skill for the review checklist).

## Existing runs to preserve/regression-check (do not break)
- `nsat-core/MACOS-WALLET-STATUS.md`: wallet acceptance suite 32/32 (fee-10 devnet) — latest re-verification 2026-10-30.
- Desktop pytest suite: `nsat-core/desktop/satoshicore-wallet/tests/` (keystore consolidation, archive wallet, e2e, shielded state).
- `satoshicore-web` SDK↔Gateway contract tests (10/10 at last evidence).

## Mandatory validation commands
- Desktop: `cd nsat-core/desktop/satoshicore-wallet && python3 -m pytest tests/ -q`
- Web: `cd satoshicore-web && npm test -- --run`
- Core shielded: `cd nsat-core && ./src/satoshicore test "shielded*"` and `cd nsat-core/shielded/rust/nsat-zk && cargo test`
- Devnet lifecycle: `bash nsat-core/scripts/wallet-devnet.sh` (isolated), then run wallet flows; record exit codes.

## Acceptance criteria
- Every feature row in WALLET-COMPLETION-MATRIX.md links to a passing named test or BLOCKED_ENVIRONMENT note with handover.
- Failures are reported as failures — no skipped tests, no weakened assertions to force green.

## Evidence requirements
- Store command outputs (exit codes, counts) in WALLET-E2E-TEST-RESULTS.md referencing devnet name/date; commit test regressions with the fix that justifies them.
