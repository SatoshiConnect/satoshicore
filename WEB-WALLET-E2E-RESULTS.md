# NSAT Web Wallet — E2E / Acceptance Results

Cycle: 2026-10-31, on commit `0575685` (+ this doc set). All numbers are from actual runs in this session; nothing is projected.

## 1. Suites run this cycle

| Suite | Command | Result |
|---|---|---|
| Static-export acceptance | `npm test` (repo root) | 5/5 PASS |
| Security scan of built artifact | `node tests/security-scan.mjs` | PASS — 30 files scanned, zero credential/admin/internal-service findings |
| Gateway + identity contract suite | `cd services/api-gateway && npm test` | 21/21 PASS |
| Devnet E2E (real ledger write path) | `NSAT_E2E=1 node tests/e2e-send.test.mjs` | 5/5 PASS |

## 2. E2E suite detail (`tests/e2e-send.test.mjs`)

All five tests ran against a FRESH disposable devnet spawned by the suite
itself (own random passphrase, own ephemeral core port, own ephemeral gateway
port; suite-cleanup kills its processes):

| Test | Verifies |
|---|---|
| `setup: disposable devnet + gateway` | disposable core AND real gateway server come up and greet HTTP |
| `no Mainnet literal ever advertised by the disposable core` | network/name guard: disposable network identity can never masquerade as Mainnet |
| `key codec round-trip` | `decodeSeed(S) → ed25519Keypair → encodeG` EXACTLY equals the devnet's `GENESIS_ROOT_PUBLIC_KEY` in the node config |
| `CREATE transfer: sign → submit → PENDING → finalize → exact conservation` | full lifecycle: derived sequence via gateway account read → locally signed (Ed25519) → gateway relay (`POST /api/v1/tx`) → core verdict PENDING → finalization (treasury sequence advances) → destination account exists with the EXACT starting balance → treasury debit EXACTLY `amount + fee` (BigInt comparison, no float) |
| `wrong-network envelope is rejected and mutates nothing` | envelope signed with a counterfeit passphrase is NOT accepted as PENDING; treasury balance and sequence byte-identical before/after |

Gating: without `NSAT_E2E=1` the suite skips (so `npm test` stays hermetic;
no devnet is started, no writes happen).

## 3. Browser (Chromium) acceptance

From the previous UI-acceptance cycle (commit `519aea4` window, verified in a
live Chromium preview against a disposable devnet): wallet import → expected
public key derived and shown; `balance128` formatted exactly; fee preview
rendered live from the ledger (10 stroops); network identity displayed
exact-match. Four interactive defects found in that cycle were fixed in
`519aea4` and the fixes are covered by the gateway/identity suites re-run here.

## 4. Unverified (honest gaps)

- Safari/WebKit, iOS Safari, Android Chromium: no device/OS access in this environment → UNVERIFIED (not "failed"; do not claim them).
- Production-gateway Mainnet read-only pass (network/status + fee + account read from the public HTTPS gateway): BLOCKED — no public production gateway is deployed yet (see runbook §5).
- Independent cryptographic audit: PENDING_EXTERNAL by scope definition.

## 5. Conservation assertion (the important one)

```
treasury_after == treasury_before - amount - fee     (exact BigInt equality)
destination_balance == amount                        (exact)
wrong-network tx: balance and sequence UNCHANGED     (exact)
```
Observed values in the run: CREATE of 2× base reserve stroops, fee = live base
fee (10) from the devnet ledger header; ledger close observed via sequence
advance poll. (Disposable devnet only — zero Mainnet writes were performed.)
