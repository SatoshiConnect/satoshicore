# WALLET-SKILLS-INVENTORY.md — NSAT Universal Wallet skills (2026-10-31)

Location: `.agents/skills/` (workspace project root — active for this thread's work).
Validity check performed: every `SKILL.md` present, starts with `---`, has `name:`
frontmatter — all 9 pass (verified by script, see transcript).

## A. Installed public skills (Part 1)

| # | Skill dir | Skill name (frontmatter) | Purpose | Invocation | Install status |
|---|---|---|---|---|---|
| 1 | `react-best-practices/` | `vercel-react-best-practices` | React/Next.js performance rules (70 rules) — governs WalletPanel/page refactors | invoked by Codebuff on React/Next.js wallet UI tasks | **INSTALLED** — source `vercel-labs/agent-skills`, pinned commit `1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62`, MIT, frontmatter validated |
| 2 | `react-native-skills/` | `vercel-react-native-skills` | React Native/Expo rules — governs any future mobile port | invoked on React Native/Expo/mobile tasks | **INSTALLED** — same pinned commit, MIT. Note: the requested name "react-native-guidelines" does not exist upstream; this is the real skill. |
| 3 | `web-design-guidelines/` | `web-design-guidelines` | Web interface/a11y/UX review checklist — governs wallet UI audits | invoked for "review my UI"/a11y audits | **INSTALLED** — same pinned commit. No license declared upstream (recorded honestly). |

Full provenance (URLs, commits, licenses, install method): `.agents/skills/SOURCE.md`.
No upstream install scripts were executed; only `SKILL.md`-referenced doc files copied as-is.

## B. Created NSAT-specific skills (Part 2)

| # | Skill dir | Purpose | Invokes/trusts |
|---|---|---|---|
| 4 | `nsat-wallet-orchestrator/` | Coordinates wallet work, maintains completion matrix, delegates to specialists, blocks premature done-claims | all nsat-* skills |
| 5 | `nsat-wallet-engine/` | Wallet engine rules: BigInt money, single codec (`nsatCodec.js`), network identity gate, local signing, byte-identical encoders | nsat-cryptography, nsat-wallet-testing |
| 6 | `nsat-cryptography/` | Ed25519/strkey, Orchard/Halo2 shielded proofs, commitments/nullifiers, deterministic vectors; forbids invented constants; forbids claiming audit | reads `nsat-core/shielded/rust/nsat-zk`, core tx code |
| 7 | `nsat-wallet-security/` | Key custody invariants, keystore/backup safety, redaction, no-secret-in-commits scanning, no invented BIP39 claims | reads keystore.py/keychain.py/keybackup.py |
| 8 | `nsat-cross-platform/` | Platform support matrix honesty; reuses existing Next.js web UI + Tauri desktop; explicit unavailable-browser-WASM shielded stance | nsat-wallet-engine, nsatw-security, web-design-guidelines |
| 9 | `nsat-wallet-testing/` | Evidence-backed acceptance on isolated devnet; preserves the existing 32/32 suite; forbids live-Mainnet mutations | nsat-cryptography, nsat-wallet-security |

All six: YAML frontmatter valid; each contains triggers, files-to-inspect, procedure,
constraints, mandatory validation commands, acceptance criteria, and evidence requirements.

## C. Validation record
- Frontmatter script run over all 9 dirs → 9/9 `yaml-ok` with matching `name:`.
- Directory layout matches Codebuff discovery contract `.agents/skills/<skill>/SKILL.md`.
