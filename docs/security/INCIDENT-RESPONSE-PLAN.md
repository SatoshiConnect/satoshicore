# INCIDENT RESPONSE PLAN — NSAT (scoped, evidence-first)

Scope: web wallet, gateway, and the operator-side actions the owner can execute
on the iMac without accessing live validator runtimes this session. Validator
runtime operations remain owner-controlled.

## Severity ladder
| Sev | Example | Initial response |
|---|---|---|
| S1 | Suspected/confirmed fund theft from a user wallet; Treasury compromise | Freeze public relay (unpublish site / suspend gateway front) — owner decision; preserve all logs, announce honestly |
| S2 | Gateway serving wrong data / identity mismatch / new admin route observable | Disable wallet signing UI (fail-closed identity already does this when identity mismatches); rotate nothing; capture evidence |
| S3 | Dependency vulnerability in runtime deps (Next/glob/postcss) | Assess exposure vs static-export posture; patch within the release-gate process |
| S4 | Devnet/test artifacts exposed | Rebind to loopback (codified as `NSAT_GATEWAY_HOST`), audit for exposure window |

## Playbook items (concrete commands)
- **Freeze public relay (S1/S2, owner)**: stop the HTTPS front on the iMac
  (`sudo launchctl remove <gw label>` per existing reverse-proxy config) — this
  does NOT touch validators or the ledger. Restore per same config.
- **Capture evidence (safe)**: `lsof -nP -iTCP`, `tail -n 200` of gateway stdout
  log (fixed-field structured lines, secrets-free), `git log --oneline -20`
  reproduction of commits.
- **Proof-of-integrity after any incident**: rerun
  `node --test services/api-gateway/tests/` and `node --test tests/keystore.test.mjs`
  and compare the live `network/status` identity against
  `NSAT Mainnet ; October 2026 ; bc3098829fffc717`.
- **No automatic rollback of ledger, validator binaries, or Shielded state** —
  those are production mutations requiring the owner's written approval each
  time (SECURITY-RELEASE-GATES gate 9).

## Recovery posture (verified capabilities)
- Encrypted keystore backup → restore path exists and is regression-tested
  (restore refuses malformed blobs).
- Gateway restart is stateless and safe (no persistent process state beyond
  in-memory rate buckets).
- Ledger/validator recovery uses the existing operator procedures (out of web
  scope, documented in nsat-core ops docs).

## Disclosure process
- Report privately to the owner first (single named person).
- Past-FIX advisories cite exact commit hashes that closed each issue.
- The security posture is always reported in the existing
  RESIDUAL-RISKS/PASS matrix; claiming "100% secure" is prohibited for
  every document in this series.

## Honest limitation
Compromise of the host's root or of an admin session is an S1 with no software
playbook in this repo — remediation is physical/key custody (owner actions in
IMAC-HARDENING-RUNBOOK).
