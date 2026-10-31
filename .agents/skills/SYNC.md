# Skill synchronization between the Web and Core repositories

`satoshicore-web` and `nsat-core` are separate git repositories but share the
NSAT engineering skills (drive same wallet stack). To avoid fragile
developer-machine paths, keep them in lockstep with a one-command copy:

```sh
# from the workspace containing both repos:
for s in react-best-practices web-design-guidelines nsat-wallet-orchestrator \
         nsat-wallet-engine nsat-cryptography nsat-wallet-security \
         nsat-cross-platform nsat-wallet-testing; do
  rsync -a --delete "nsat-core/.agents/skills/$s" "satoshicore-web/.agents/skills/"
done
cp nsat-core/.agents/skills/SOURCE.md            satoshicore-web/.agents/skills/SOURCE.md
cp nsat-core/.agents/skills/WALLET-SKILLS-INVENTORY.md satoshicore-web/.agents/skills/
```

Provenance & licenses: see SOURCE.md (public skills pinned to
vercel-labs/agent-skills `1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62`, MIT).
`nsat-web-mainnet-release` is web-repo ONLY (procedural skill, no
third-party content). After any upstream skill change, re-run the sync and
commit BOTH repos.
