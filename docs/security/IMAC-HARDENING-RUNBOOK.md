# iMAC HOST HARDENING RUNBOOK — read-only baseline + reversible changes

Scope note: this session's host access was limited to the NSAT workspace and
its own processes. The runbook marks each step VERIFIED, REVERSIBLE-CHANGE, or
BLOCKED_OWNER_ACTION, and makes no claim that process isolation protects
against full host compromise.

## Read-only baseline findings (verified 2026‑10‑31)

| Check | Result |
|---|---|
| Core RPC (11626) bound to loopback | PASS (external probe refused) |
| Gateway prod 8790 process owned by user, launchd-independent child | VERIFIED (node server.js, PID 95633) |
| Disposable devnet gateway was bound to all interfaces | FIXED THIS SESSION (restarted PID 12908, bound to 127.0.0.1) |
| Working tree / repos contain no keys or seeds | PASS (secret scan 30 files) |

## REVERSIBLE-CHANGE applied this session
- `server.js` now supports `NSAT_GATEWAY_HOST` (bind address). Default remains
  all-interfaces (required by the production TLS front); disposable/local
  instances must set `127.0.0.1`. Documented in code and GATEWAY-SECURITY-AUDIT.
- The disposable devnet gateway was restarted under loopback binding only. No
  Mainnet process was stopped or restarted.

## BLOCKED_OWNER_ACTION (checklist, in priority order)

1. **macOS patch level**: `softwareupdate -l` and apply pending OS updates (restart window must avoid ledger-close of live validators — schedule with owner).
2. **Firewall**: enable application firewall; explicitly allow the gateway front port (HTTPS 443 via the reverse proxy) and deny any direct external ingress to 11626/11731/8787/8788/8790.
3. **FileVault**: confirm enabled on the host volume (data-at-rest for ledger + keystore).
4. **Remote access**: disable or restrict Remote Login/Screen Sharing to a specific man admin IP; no password auth over SSH (keys only).
5. **launchd isolation**: install the Gateway as a user-scoped `LaunchAgent`/`LaunchDaemon` with `RunAtLoad=true`, `KeepAlive=true`, hardened runtime: no `Root` user, no write access to validator data dirs; validator processes keep their existing supervision UNCHANGED (never touch live validators without explicit approval).
6. **Filesystem permissions**: `chmod 700` on validator key/data directories; verify no group/other read on ledger databases.
7. **Backup & recovery**: rehearse the documented restore into an isolated environment (see INCIDENT-RESPONSE-PLAN); confirm backup freshness < 24 h and off-host copy exists.
8. **Host failure design**: three validators + vault on one physical iMac is a single-host liveness SPOF. Multi-host validator distribution is a topology migration requiring separate approval — DO NOT migrate without it. Safest interim: an off-host passive archive + a pre-approved second-host validator plan on paper.

## Honest limits
- None of the above converts process isolation into defense against a root-level compromise: if the host's root is lost, keystores on disk and any unsandboxed signing workflow are lost. That is the single most important operational risk and is NOT claimable away.
