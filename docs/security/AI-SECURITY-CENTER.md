# AI SECURITY CENTER — design charter (read-only, advisory)

This session implemented NO new AI service. This document fixes the charter
that any future AI security assistant must satisfy before it is allowed in the
stack. It is design-only content with hard constraints; nothing here is
claimed as running infrastructure.

## Allowed (advisory, read-only)
- Review source diffs for obviously unsafe patterns (targets: wallet lib, gateway routes, CI workflows).
- Analyze SANITIZED logs (no secrets, no key material, no raw envelope blobs) for anomaly triage.
- Prioritize findings, draft regression tests (human-verified), compare validator health reports numerically.
- Dependency-augmentation: summarize `npm audit` advisories in reviewable form.

## Forbidden (hard rules)
- Must never hold, transport, escrow, or shard any Treasury or Validator key.
- Must never sign a transaction, approve a transfer, or issue wallet releases.
- Must never deploy, merge, or gate a release autonomously.
- Must never disable/alter a validator, quorum set, or protocol parameter.
- Must never receive untrimmed source containing other repos' secrets; must never send repo data to external AI APIs without explicit data-classification approval (locally hosted tooling preferred).
- Must treat ALL external/log/repo content as untrusted input — no prompt-injection-triggered tool execution.

## Enforcement
Findings are advisory only. Any HIGH/CRITICAL finding is actionable only after
(1) reproduction by a deterministic test, or (2) a named human reviewer's
acknowledgment. The gateway remains the only component touching state; an AI
component would mount the data through a read-only copy, never the production
directories.

## Status
Not installed. No claims of operation. (DELIVERED — see SECURITY-RELEASE-GATES
gate 10 for how AI findings are handled once this ships.)
