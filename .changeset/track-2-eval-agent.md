---
'@tangle-network/browser-agent-driver': minor
---

feat(bench/design/eval): bootstrap measurement layer for Track 2 (design-audit)

Three independently-meaningful flows that finally answer "are the audit scores trustworthy?" — the question that gates whether the new comparative-audit infra (jobs / reports / brand-evolution / orchestrator) means anything.

| Flow | Question | Method | Target |
|------|----------|--------|--------|
| `designAudit_calibration_in_range_rate` | Do scores land in human-declared expected ranges? | corpus tier ranges, fraction-in-range | ≥ 0.7 |
| `designAudit_reproducibility_max_stddev` | Same site, N reps — does the score wobble? | per-site stddev, max across sites | ≤ 0.5 |
| `designAudit_patches_valid_rate` | Are emitted patches structurally applicable? | reuse `validatePatch` from Layer 2 | ≥ 0.95 |

**`bench/design/eval/`** — pure-function evaluators, AI SDK independent. `run.ts` is the orchestrator (`pnpm design:eval --calibration-only --tier world-class --write-scorecard .evolve/scorecard.json`). `scorecard.ts` is the envelope shape. Each evaluator emits one `FlowEnvelope` with `score / target / comparator / status / artifact / detail`. The runner merges fresh flows into `.evolve/scorecard.json` without clobbering older flows from prior generations.

**Baseline established:** `designAudit_calibration_in_range_rate = 1.00` (5/5 world-class sites in expected range). Stripe → 8.0, Linear → 9.0, Vercel → 8.0, Raycast → 8.0, Cursor → 8.0.

**Real gap surfaced:** `designAudit_patches_valid_rate = unmeasured`. None of the 4 critical/major findings on stripe.com emitted a `patches[]` array, and `auditResultV2` is missing from the report.json. Layer 1 v2 + Layer 2 patches aren't writing through to the v1-shaped output. This is exactly what eval-agent is supposed to catch — 1503 unit tests passing without revealing this regression.

+9 new tests across `design-eval-scorecard` and `design-eval-patches`. Total: 1503 passing.
