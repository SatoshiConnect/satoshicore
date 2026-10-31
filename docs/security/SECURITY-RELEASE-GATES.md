# SECURITY RELEASE GATES — deployment control

Purpose: hard rules that decide when a security-relevant change may ship. No gate
may be bypassed "because the build is green".

## Gates, in enforcement order

1. **No consensus change rides wallet/gateway hardening.** Any PR touching
   Tokenize/*, Upgrades, Herder, LedgerManager, or anything under nsat-core
   consensus paths must be a separate reviewable change with its own safety
   checks and explicit production approval. CLEAN this session.
2. **Identity gate**: `node --test services/api-gateway/tests/` must include the
   9-case exact-identity suite green. A change that loosens the network
   identity check is REJECTED outright.
3. **Key-custody gate**: `node --test tests/keystore.test.mjs` green after any
   change to `lib/nsatWallet.js` or `WalletPanel.js`. Any new plaintext seed
   transmission/persistence path is REJECTED.
4. **Static export gate**: `next build` + `node tests/static-export.test.mjs`
   green before any Pages deployment (plain static files, correct base path, no
   secrets or key material in `out/`).
5. **Gateway suite green**: all `services/api-gateway/tests/*` green (including
   busy-retry, rate limit, 413, hardening-header policy).
6. **Secret scan green**: `node tests/security-scan.mjs` (30 files clean).
7. **Supply-chain policy**: `npm audit` findings reported;
   any rename/change of runtime dependencies in the wallet bundle requires
   explicit review; zero new runtime deps is preferred (gateway remains
   zero-dep).
8. **Devnet isolation gate**: disposable networks bind to loopback only. Any
   code path that could bind a devnet gateway/core to all interfaces must be
   flagged in review (`NSAT_GATEWAY_HOST=127.0.0.1` default for local/devnet).
9. **Production action gate**: no live Mainnet mutation (tx, restart, binary
   replacement, protocol setting) without a written approval that states the
   change, window, and rollback.
10. **AI gate (AI-SECURITY-CENTER)**: AI findings are advisory; enforcement or
    action requires a deterministic test or a human reviewer signoff.

## Current gate status (2026‑10‑31)

- Gates 2,3,4,5,6,8 : PASS this session (evidence in SECURITY-TEST-RESULTS).
- Gate 7: PASS with 21 tracked upstream findings (RESIDUAL-RISKS) — release not blocked, but cannot be described as fully exported.
- Gate 1, 10: enforced by design; no consensus change / AI action this session.
- Gate 9: never exercised (no Mainnet mutation performed).
