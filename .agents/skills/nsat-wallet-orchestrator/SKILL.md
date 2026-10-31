---
name: nsat-wallet-orchestrator
description: Coordinates all NSAT Universal Wallet engineering work across the satoshicore web wallet and the SatoshiCore desktop/shielded wallet. Use when starting any wallet feature, bug-fix, audit, or release task for the NSAT (SatoshiCore) ecosystem — it maintains the completion matrix, assigns work to specialist nsat-* skills, and blocks premature "done" claims without passing tests.
metadata:
  author: nsat
  version: "1.0.0"
---

# NSAT Wallet Orchestrator

## When to use
Any task touching the NSAT wallet surface: web wallet (`satoshicore-web`), desktop
wallet (`nsat-core/desktop/satoshicore-wallet`), Shielded wallet flows, wallet
SDK/Gateway contracts, or wallet release engineering. Do not use for Core consensus,
Explorer, or Gateway-only server work.

## Source of truth to read first
1. `satoshicore-web/lib/nsatWallet.js`, `satoshicore-web/lib/nsatCodec.js`, `satoshicore-web/lib/nsatClient.js`, `satoshicore-web/components/WalletPanel.js`
2. `nsat-core/desktop/satoshicore-wallet/satoshicore_wallet/` (core.py, keystore.py, keychain.py, keybackup.py, shielded.py, rpc.py) and its `tests/`
3. `nsat-core/docs/NSAT-FEE-POLICY.md` (fee policy gate — wallet must not invent fees)
4. `nsat-core/MACOS-WALLET-STATUS.md` (latest recorded acceptance evidence, e.g. 32/32 suite)
5. `satoshicore-web/services/api-gateway/server.js` + `services/api-gateway/tests/gateway.test.js` (SDK↔Gateway contract)

## Orchestrator procedure
1. Check `git status`/`git log` in BOTH repos first; never assume prior observations are current. Record HEADs.
2. Build/update a feature completion matrix (accounts / transparent / shielded / platforms / UI / security) with per-feature status: DONE (test+evidence), PARTIAL, MISSING, BLOCKED_ENVIRONMENT.
3. For each missing/partial feature, delegate to the specialist skill:
   - cryptographic correctness → nsat-cryptography
   - engine/serialization/FFI → nsat-wallet-engine
   - key custody/backup/redaction → nsat-wallet-security
   - platform builds/UI stack → nsat-cross-platform
   - acceptance runs → nsat-wallet-testing
4. Never duplicate an existing implementation: search both repos before writing anything new.
5. Rejected-change rules: no changes to Mainnet genesis/supply/fee/consensus; no live validator restarts; no Treasury key access; no new second wallet project.

## Hard constraints
- Wallet fee handling must route through the fee-policy gate (`verify_network_fee_policy`, live baseFee 10); a mismatch must refuse to send, never silently adjust.
- Preserve existing wallet data formats and the 32/32 acceptance suite compatibility.
- Do not claim a feature complete without a passing named test and recorded evidence path (commit or evidence/ file).

## Mandatory validation
- `git -C nsat-core status --short` and `git -C satoshicore-web status --short` clean or explicitly accounted for before declaring completion.
- Run the relevant specialist skill's validation commands (see each SKILL.md).
- Wallet acceptance suite on isolated devnet: see nsat-wallet-testing SKILL.md.

## Acceptance criteria
- Completion matrix updated with evidence links (test names + commit hashes).
- Every delegated task closed with its skill's acceptance criteria met.
- No scope creep: DEX/exchange/bridge/NFT/new-token features are out of bounds.

## Evidence requirements
- Record both repo HEADs, test commands, exit codes, and artifact paths in the final report or `WALLET-COMPLETION-MATRIX.md`.
