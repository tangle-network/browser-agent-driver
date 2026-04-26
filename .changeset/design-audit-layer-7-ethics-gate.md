---
'@tangle-network/browser-agent-driver': minor
---

feat(design-audit): Layer 7 — domain ethics gate (+ Layer 6 composable predicates)

Adds a hard score floor for pages that fail domain-specific ethics rules and the predicate vocabulary that lets those rules target the right audience/modality/regulatory context. RFC: `docs/rfc/design-audit-world-class.md`.

- **Ethics rule set** (`src/design/audit/ethics/rules/{medical,kids,finance,legal}.yaml`) — curated, citation-backed rules covering medication dosage disclosure (FDA 21 CFR 201.57), kid-facing dark-pattern guards (COPPA, FTC Endorsement Guides), finance fee disclosure (TILA / Reg Z), and legal disclaimer presence.
- **Detector kinds** (`src/design/audit/ethics/check.ts`) — `pattern-absent`, `pattern-present`, `llm-classifier`. Pattern checks are case-insensitive against page text; the LLM classifier asks for a single yes/no token to keep latency + cost predictable.
- **Hard rollup floor** — a `critical-floor` violation caps the rollup at 4; `major-floor` caps at 6. `PageAuditResult.preEthicsScore` preserves the LLM's pre-cap score so reports can show "would have scored 8, capped at 4 — fix the dosage disclosure".
- **Composable predicates (Layer 6)** — extends `AppliesWhen` with `audience`, `modality`, `regulatoryContext`, and `audienceVulnerability`. A pediatric medical app on tablet for clinicians now matches the medical *and* kids rule sets simultaneously instead of forcing one classification.
- **CLI flags**: `--skip-ethics` (test-only bypass, audited + warned), `--ethics-rules-dir <path>` (override the builtin yaml), `--audience`, `--modality`, `--audience-vulnerability` (comma-separated tag lists threaded into rule matching).
- **Fixtures** (`bench/design/ethics-fixtures/`) — paired pass/fail HTML for each rule category, used by `tests/design-audit-ethics-{rules,check}.test.ts`.

Backwards compat: rules ship empty by default for any classification not on the curated list, so existing audits see no change unless they opt in via `--audience`/`--modality` or land on a covered domain. `EthicsViolation` is exported from both `src/design/audit/types.ts` and `v2/types.ts`; `PageAuditResult.ethicsViolations` is optional.
