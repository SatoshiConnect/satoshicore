# TREASURY ISOLATION PLAN — Founder Treasury (software-side controls only)

Constraint honored: NO live Treasury key was accessed, read, printed, or moved
this session. Everything here is software-side protection that does not require
key access, plus owner actions listed precisely.

## Current state (verified)
- The Gateway and the web wallet contain **no Treasury material** by audit: `secret scan` clean across 30 files; gateway has no key-handling path; CI has no Mainnet secrets.
- Treasury signing is a separate operator workflow, not part of the public stack.
- Mainnet identity check prevents a running devnet from being presented as Mainnet (no accidental signing over wrong network).

## Software-side protections IN PLACE
| Control | Status |
|---|---|
| No Treasury secrets in repositories (secret scan) | PASS |
| No Treasury keys in Gateway process, browser, or CI | PASS (architecture) |
| No automated/AI-initiated Treasury signing anywhere in the stack | PASS (architecture: no such code path exists) |
| Wallet signing-key/address integrity check protects user wallets against tampered custody metadata | PASS (new this session) |
| Keystore backup blobs are ciphertext-only | PASS |

## Owner-action items (BLOCKED_OWNER_ACTION — exact safe steps)

1. **Key custody location**: confirm Treasury keys live outside any Git repo and outside the Gateway process's filesystem reach. `git ls-files` in both repos must show no key files. (Read-only check, safe.)
2. **Backup separation**: keep one encrypted offline copy on removable media, stored separately from the iMac; test a restore into a THROWAWAY wallet instance only (never import into the live validator host).
3. **Transaction intent verification**: every Treasury outbound should be typed into a terminal step that echoes `destination G-address, amount (stroops), network identity` and requires an explicit typed confirmation (no copy-paste of raw envelope into curl without the echo step).
4. **Multisignature / MPC**: the current protocol does NOT provide Treasury multisignature — do not advertise it as available. If protocol-level multisig is ever required, that is a protocol design + external review + coordinated upgrade item, not a software patch.
5. **Hardware-backed offline signing**: NOT currently supported end-to-end by the existing workflow; assigning a dedicated offline machine (air-gapped) for signing is the practical equivalent achievable today.

## Non-goals
- No new cryptographic signing design was introduced this session (would require external review before production use).
- No existing key was rotated, replaced, deleted, or read.
