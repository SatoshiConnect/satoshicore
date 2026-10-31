---
name: nsat-cryptography
description: Enforces NSAT cryptographic correctness — Ed25519 signing, Orchard/Halo2 shielded proofs, commitment/nullifier handling, key derivation compatibility, replay/double-spend protection, and deterministic vectors. Use for any change touching proof generation/verification, strkey/Ed25519 derivation, nullifiers, or shielded deposit/transfer/withdraw semantics. Never invents protocol constants; always reads the real Core implementation.
metadata:
  author: nsat
  version: "1.0.0"
---

# NSAT Cryptography

## When to use
Any work involving: strkey/seed encoding, Ed25519 signing/verification, shielded proof
create/verify, Merkle commitment tree, nullifiers, anchors, or contradiction checks
between wallet-produced and core-verified proofs.

## Read the real implementation first (never use remembered formats)
- Strkey & signing: `nsat-core/src/main/Native/` strkey helpers, `nsat-core/src/transaction/` signing paths
- Shielded protocol: `nsat-core/shielded/rust/nsat-zk/` (Rust proof kernel + tests incl. `failed_kernel_persistence_is_internal_not_consensus_rejection`), and `nsat-core/src/transaction/` shielded op handling
- Verifier dylib identity: pinned SHA-256 in `nsat-core/evidence/` (verifier dylib) and `MAINNET-IDENTITY-MANIFEST.md`
- Wallet-side bindings: `nsat-core/desktop/satoshicore-wallet/satoshicore_wallet/shielded.py`

## Hard rules
1. Protocol constants (curve points, hash domains, version blobs) come from Core source — never from AI memory or this skill file.
2. One provenance: proof generation must use the same pinned verifier/creation code path as Core tests; adding a second ZK implementation is prohibited without a pinned SHA-256 record.
3. Nullifier list writes must be crash-atomic with the applied shielded op (journal pattern verified by the existing C++ rollback test).
4. Replay/double-spend: submitting an already-nullified note must fail deterministically, both fresh and after restart recovery — regression tests required for both.
5. Monetary conservation: deposit − transfer − withdrawal sums must reconcile exactly to the shielded pool delta per ledger; a conservation mismatch is a severe defect.
6. Deterministic test vectors: new crypto-facing features must commit vectors (inputs → expected bytes/roots) reproducible offline.
7. Internal review is NOT certification: never claim independent cryptographic audit; audit status stays PENDING_EXTERNAL.

## Mandatory validation
- `cd nsat-core && ./src/satoshicore test "shielded*"` must pass (current baseline: 1 case, 7 assertions).
- `cd nsat-core/shielded/rust/nsat-zk && cargo test` must pass (current baseline: 5 unit + 2 integration, 0 failed).
- Wallet shielded flows on isolated devnet: deposit → transfer → withdraw with exact conservation, double-spend attempt rejected, restart consistency.

## Acceptance criteria
- All core shielded tests + wallet devnet shielded flows pass with recorded evidence.
- No new cryptographic constants/formats invented; every format change is traceable to a Core commit.

## Evidence requirements
- Test output captured to an evidence file or report section; verifier/binary SHA-256 recorded if binaries change.
