# NSAT — SECURITY ARCHITECTURE (current, verified state)

Commit basis: satoshicore-web `f8004b1…` (web), nsat-core `9af27bad…` (core), 2026‑10‑31.

## Components and isolation

```
Browser (wallet UI, signing)
  │  HTTPS only (wallet.satoshicore.org)   ← static export, GitHub Pages
  ▼
HTTPS reverse proxy (front for prod Gateway *:8790)
  ▼
API Gateway  (node server.js, zero runtime deps, keyless)
  │  route allowlist: /health /api/v1/{network/status,chain/info,account,tx}
  │  rate limit 120/min/IP · 64 KiB body cap · 10 s upstream timeout · MVP-TLS headers
  ▼  loopback http://127.0.0.1:11626
NSAT Core Mainnet node(s) — validator A/B/C on the owner iMac
  └ Shielded engine (Rust verifier dylib, pinned SHA‑256) — out of this doc's live path
```

Hard boundaries implemented and tested this session:

1. **Key custody** — Ed25519 seeds exist only in browser memory; keystore is AES‑256‑GCM with PBKDF2‑SHA‑256 (600k iterations) in `localStorage`; unlock returns `Uint8Array(32)` only; nothing crosses the network except signed XDR envelopes.
2. **Gateway** — no key-handling code path exists; `validateEnvelope` accepts base64 XDR only; admin RPC unreachable (allowlist + 404 probes).
3. **Core RPC** — loopback binding; an external probe to the host interface is refused.
4. **Disposable networks** — devnet gateway and its core live behind loopback (`NSAT_GATEWAY_HOST=127.0.0.1` now enforced by config; production gateway keeps the all-interfaces bind required by its TLS front).
5. **Identity** — the wallet enables signing/sending only after the on‑chain node reports the byte-exact Mainnet passphrase `NSAT Mainnet ; October 2026 ; bc3098829fffc717`; a devnet cannot masquerade; misconfiguration fails closed on the send/review path.

## What is deliberately NOT claimed

- Process isolation ≠ host-compromise resistance (the gateway and the validators are ordinary user processes on one host).
- CORS excludes nothing for non-browser clients; rate limiting/validation is the actual control and applies to every client.
- Browser runtime integrity (extensions, exploit chains) is assumed hostile; the mitigation is minimizing the window and lifetime of key material, never "the browser is safe".
- Cryptographic primitives (ed25519/TweetNacl, Halo2 in Shielded) are NOT specially strengthened here; their trustworthiness rests on upstream review + external audit (PENDING_EXTERNAL).
