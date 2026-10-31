# .agents/skills — upstream provenance

| Skill dir | Origin | Upstream repo | Pinned commit | License | Installed (UTC) |
|---|---|---|---|---|---|
| react-best-practices | https://github.com/vercel-labs/agent-skills (skills/react-best-practices) | vercel-labs/agent-skills | `1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62` | MIT (frontmatter `license: MIT`) | 2026-10-31 |
| react-native-skills | https://github.com/vercel-labs/agent-skills (skills/react-native-skills) | vercel-labs/agent-skills | `1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62` | MIT (frontmatter `license: MIT`) | 2026-10-31 |
| web-design-guidelines | https://github.com/vercel-labs/agent-skills (skills/web-design-guidelines) | vercel-labs/agent-skills | `1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62` | **none declared** (no license field in SKILL.md; no repo-level LICENSE found) | 2026-10-31 |

Note: the requested name "react-native-guidelines" does not exist upstream; the actual
skill is `vercel-react-native-skills` and that is what was installed.

Installation method: `git clone --depth 25` of the upstream repo at the pinned commit,
then a plain `cp -R skills/<name> .agents/skills/<name>`. No upstream install scripts
were executed.
