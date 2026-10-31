---
name: nsat-cross-platform
description: Builds and verifies NSAT wallet functionality across platforms (web, macOS, Windows, Linux, iOS, Android) on the existing stacks — reuse the existing Next.js web UI and the existing Tauri/desktop wallet; prefer React Native for mobile only if it fits the existing architecture; provides an explicit browser-crypto/WASM strategy for shielded proofs. Use when adding platform support, choosing UI stacks, or verifying platform builds.
metadata:
  author: nsat
  version: "1.0.0"
---

# NSAT Cross-Platform

## When to use
Deciding/validating platform support, porting wallet features to a new platform,
selecting bindings (FFI/WASM/N-API), or planning any "does X platform work?" claim.

## Current reality to respect
- Web: `satoshicore-web` (Next.js App Router) with `app/wallet/page.js`, `components/WalletPanel.js`, `lib/nsatCodec.js|nsatWallet.js|nsatClient.js` — the canonical browser UI; reuse and extend it.
- macOS desktop: `nsat-core/desktop/satoshicore-wallet` (Tauri/Rust shell + Python engine; existing installed app `SatoshiCore Wallet.app`; see `WALLET-CONSOLIDATION-2026-10-25.md`, `WALLET-QUALITY-REPORT.md`).
- Windows/Linux: Tauri engine supports them; no verified production build exists yet — treat as PARTIAL/BLOCKED until built+runtime-tested.
- Shielded proofs: Rust-only today (`nsat-core/shielded/rust/nsat-zk`). There is NO verified browser WASM shielded proof path — do not advertise browser shielded support without one; the web wallet must not fake shielded features.

## Stack rules
1. Do not launch a second UI framework: extend the existing Next.js web wallet and existing Tauri desktop app.
2. React Native is acceptable for iOS/Android only with a justified integration plan (shared engine via native bindings or explicit RPC to Gateway/WalletCore); requires an actual device/simulator build before any platform is called supported.
3. Browser crypto constraints are explicit: no filesystem keystores, weaker OS-backed storage → derive the web threat model from nsat-wallet-security skill; document any capability the browser cannot safely hold.
4. Every platform claim in WALLET-PLATFORM-COMPATIBILITY.md must name: engine used, bindings, key storage model, and the exact build+runtime test that verified it.

## Mandatory validation (per platform claim)
- Web: `cd satoshicore-web && npm run build && npm test -- --run`; then dev-server page check of wallet flows.
- macOS: `MACOS-WALLET-STATUS.md` suite (32/32) remains green; rebuilt .app launches and passes read-only checks.
- Other platforms: only claim after an actual build + runtime test artifact exists; otherwise status BLOCKED_ENVIRONMENT with a reproducible handover (exact commands, signing requirements, device needs).

## Acceptance criteria
- No unstested platform is listed as supported.
- Shared engine changes keep byte-identical tx encoding across platforms (see nsat-wallet-engine).

## Evidence requirements
- Build logs/exit codes per platform; runtime test notes; BLOCKED_ENVIRONMENT items carry an exact handover.
