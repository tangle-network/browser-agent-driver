---
'@tangle-network/browser-agent-driver': minor
---

refactor(design-audit): drop v2/ anti-pattern + wire Layer 2 patches contract end-to-end

Two changes that fold into one coherent diff:

**Canonicalization — no version numbers in file or directory names.** The `src/design/audit/v2/` directory is gone:
- `v2/types.ts` → `src/design/audit/score-types.ts` (scoring/classifier/patches/tags types)
- `v2/build-result.ts` → `src/design/audit/build-result.ts`
- `v2/score.ts` → `src/design/audit/score.ts`
- `tests/design-audit-v2-result.test.ts` → `tests/design-audit-build-result.test.ts`

Identifier renames: `AuditResult_v2` → `AuditResult`, `BuildV2ResultInput` → `BuildAuditResultInput`, `parseAuditResponseV2` → `parseAuditResponse`, `buildEvalPromptV2` → `buildEvalPrompt`, `buildAuditResultV2` → `buildAuditResult`, `synthesizeScoresFromV1` → `synthesizeScoresFromLegacy`, `auditResultV2` field → `auditResult`, `DesignFindingV1` → `DesignFindingBase`, `AppliesWhenV1` → `BaseAppliesWhen`, `V2_INTERNALS` → `BUILD_RESULT_INTERNALS`.

Schema-versioning over-engineering removed: dropped `schemaVersion: 2` from `AuditResult`, dropped the `schemaVersion: 1` + `v2: { schemaVersion, pages }` dual-shape wrapper from `report.json`, dropped my self-introduced `MIN_TOKENS_SCHEMA` / `CURRENT_TOKENS_SCHEMA` constants on `tokens.json`. (Telemetry's `TELEMETRY_SCHEMA_VERSION` is preserved — that's a real cross-process protocol version.)

**Layer 2 patches contract wired end-to-end.** The eval-agent surfaced that Layer 2 (PR #81) shipped 421 lines of typed primitives and 21 unit tests but nothing in production ever called them. Three independent gaps:

1. `src/design/audit/evaluate.ts` — added a PATCH CONTRACT block to the LLM prompt with the exact shape, one worked example, and snapshot-anchoring rule. Few-shot examples (`standard`, `trust`) now include `patches[]`. Brain.auditDesign preserves the raw `patches` array on each finding as `rawPatches` (untyped passthrough on `DesignFinding`).
2. `src/design/audit/build-result.ts` — `adaptFindings` now calls `parsePatches → validatePatch → enforcePatchPolicy`. Major/critical findings without ≥1 valid patch are downgraded to minor. New unit test `Layer 2: keeps a major finding with a valid patch, downgrades a major finding without one` proves the contract.
3. `src/design/audit/pipeline.ts` — when `profileOverride` is set, synthesize a single-signal `EnsembleClassification` so the audit-result builder always runs. Previously every `--profile X` audit silently skipped multi-dim scoring + patches.
4. `src/design/audit/patches/validate.ts` — snapshot-anchoring is required only when `target.scope ∈ {html, structural}`. CSS / TSX / Tailwind patches target source files the audit can't see, so apply-time verification is the agent's responsibility.

**Eval-agent caught a follow-up regression.** Calibration metric dropped from 1.00 → 0.60 → 0.00 across two iterations as the patch contract expanded the prompt. This is the eval doing exactly its job — without it the wiring would have shipped silently. Documented in `.evolve/critical-audit/<ts>/reaudit-2026-04-27.md`. Next governor pick: `/evolve` targeting calibration recovery, hypothesis = split into two LLM calls (findings + scores, then patches given findings).

+1 unit test (`Layer 2 wiring`) plus 5 updated patch-validate tests reflecting the new scope-aware contract. Total: 1505 passing.
