---
name: nsat-wallet-security
description: Enforces NSAT wallet key custody and security invariants — OS-backed secret storage, encrypted keystore, backup/restore safety, secret redaction, local signing guarantees, memory exposure reduction, lock/inactivity policies, release security acceptance. Use for any wallet feature that touches secrets, keystores, backups, clipboard, logs, or release builds.
metadata:
  author: nsat
  version: "1.0.0"
---

# NSAT Wallet Security

## When to use
Any change involving secret material, keystore/backup formats, signing surfaces,
logging of wallet operations, clipboard/screenshot handling, or release hardening.

## Files to inspect first
- `nsat-core/desktop/satoshicore-wallet/satoshicore_wallet/keystore.py` (encrypted keystore)
- `nsat-core/desktop/satoshicore-wallet/satoshicore_wallet/keychain.py` (OS keychain integration)
- `nsat-core/desktop/satoshicore-wallet/satoshicore_wallet/keybackup.py` (encrypted backup/export)
- Web secret handling: `satoshicore-web/lib/nsatWallet.js`, `components/WalletPanel.js`
- Known risk register: `nsat-core/docs/security/` (e.g. plaintext key dir known findings — `NSAT-KEY-BACKUP-PLAINTEXT-*` remediation must be owner-approved; do not auto-delete)

## Non-negotiable invariants
1. No secret or seed material is ever transmitted to a server, logged, or committed. This includes shell tool output — redact before echoing.
2. Signing happens locally with secrets held only in memory; a server- or gateway-side signing path is prohibited for real-value keys.
3. Web/platform secret storage uses the strongest available OS-backed mechanism (Keychain/Keystore/encrypted IndexedDB) — never raw localStorage/plaintext files for real keys.
4. Backup restores must verify integrity (checksum/MAC) before overwriting any existing wallet; corrupted input must fail closed.
5. Lock/inactivity policy must zero in-memory secrets on lock; no long-lived plaintext caches.
6. Honestly represent the crypto baseline: the wallet is Ed25519-account based; do NOT claim BIP39/HD compatibility unless the code actually implements it.
7. Cannot do: rotations/decryption of production identity vault (`/Volumes/SatoshiCore/MAINNET-IDENTITY-20261025/`) — those need owner approval; prepare an exact approval request instead.

## Mandatory validation
- `cd nsat-core/desktop/satoshicore-wallet && python3 -m pytest tests/test_keystore_consolidation.py tests/test_archive_wallet.py -q` (plus any touched test file) — must pass.
- Secret-scanning change check: run the repo seed-derivation scanner pattern (S-strkey detection) over changed files to prove no secret leaked into commits; report the check ran.
- Manual review that no log/print statement added in this change can receive secret values.

## Acceptance criteria
- All keystore/backup tests green; no new secret-printing path; backup roundtrip (export → restore → same key material hash, secrets never printed) verified on isolated devnet keys.

## Evidence requirements
- Test names/exit codes recorded; security acceptance noted in WALLET-SECURITY-MODEL.md with any residual risks.
