# SatoshiCore Wallet and Gateway — verified project status

Inspection recorded 2026-10-31T15:23:22Z (UTC). Status labels: `PASS`, `FAIL`, `BLOCKED`, `UNKNOWN`, `NOT_TESTED`.

## Repository and release provenance

- GitHub `main` is the documented production source branch at `b3edd6c188b3d5e52ac64859d0573d5dc0f55393`.
- `feature/web-platform-v1` is an older branch, five commits behind `main` and containing no commits absent from `main` as fetched on 2026-10-31. It is not the latest source.
- Latest `main` Pages workflow on GitHub completed successfully at `41162906664`. This confirms the workflow, not successful HTTPS access from every client.

## Live observations

| Check | Result | Evidence |
|---|---|---|
| Local Wallet API Gateway | **PASS** — `/health` returned HTTP 200, `status=ok`, version 24.0.0 | Read-only GET `127.0.0.1:8790/health` |
| Gateway-to-Core / network identity | **PASS** — `/api/v1/network/status` returned `core=ok`, `gateway=ok`, and the exact NSAT Mainnet network string | Read-only GET `127.0.0.1:8790/api/v1/network/status`; reported ledger 97963 during that probe |
| Core validators | **PASS** — latest direct sample A/B/C all synced at ledger 97966 with matching hash | Current live Core `/info` sample recorded in [Core project status](https://github.com/SatoshiConnect/nsat-core/blob/codex/ecosystem-status-20261031/PROJECT-STATUS.md) |
| Wallet site HTTPS | **FAIL from operator Mac** — TLS hostname verification rejected `wallet.satoshicore.org` because the certificate did not match the hostname. No bypass was used. | Read-only `curl -I https://wallet.satoshicore.org` |
| Wallet create/import/sign/send UI | **NOT_TESTED** in this synchronization | No browser wallet transaction was initiated |
| Gateway public TLS endpoint | **UNKNOWN** — local loopback service passed; public gateway URL and certificate were not verified | No public gateway URL is pinned in this snapshot |
| Genesis hash | **UNKNOWN** from current live probes | Gateway status returned the network string, not a Genesis hash |

## Blockers and next steps

- Repair and verify the wallet domain's TLS certificate before directing users to it.
- Run a browser-level wallet create/import/backup/restore and transparent send/receive acceptance after TLS is healthy. Do not use real funds for validation.
- Recheck public gateway exposure only after its exact public URL is documented; current local loopback health does not prove public availability.
- Shielded remains governed by the Core status and independent audit gate; this Wallet repository does not certify Shielded security.

See [`project-status.json`](project-status.json) for machine-readable status. This documentation change does not deploy the site or change any gateway or Core process.
