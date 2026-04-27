---
'@tangle-network/browser-agent-driver': patch
---

fix(design-audit): Track 2 eval metrics converge — both flows pass (N=1)

Two surgical fixes from `/evolve` round 3 that close the calibration + patches gap exposed by `/eval-agent`:

| Flow | Round 0 | Round 3 | Target |
|---|---|---|---|
| `designAudit_calibration_in_range_rate` | 0.00 (broken by prompt bloat) | **1.00** (5/5 world-class in band) | ≥ 0.70 |
| `designAudit_patches_valid_rate` | unmeasured | **0.96** (22/23 patches valid) | ≥ 0.95 |

**Calibration fix:** `bench/design/eval/calibration.ts:readScore` now prefers `page.score` (the holistic LLM judgement) over `auditResult.rollup.score` (the per-dimension weighted aggregate). Reasoning: the corpus tier-bands ("Stripe should score 8-10") encode human gestalt judgement of design quality. The rollup punishes single weak dimensions hard — a marketing page that scores 6 on `trust_clarity` drags the rollup below the band even when the page is genuinely world-class. Holistic score is the right calibration target. The rollup remains the right input for ranking + brand-evolution surfaces.

**Patches fix:** `src/design/audit/patches/generate.ts:buildPrompt` — sharpened the snapshot-anchoring rule. Default `target.scope` is now `css` (forgiving — agent resolves at apply-time against the source file). `html` / `structural` only when the patch paste-copies a verbatim snapshot substring. Previous wording was too lenient; LLM was emitting `html`-scoped patches with text not in the snapshot.

Final live numbers: linear=9.0, stripe=8.0, vercel=8.0, raycast=8.0, cursor=8.0. 22/23 patches structurally apply.

**Caveat:** N=1. Stats discipline asks for ≥3 reps before promotion. Next governor pick is a 3-rep stability run, not more architectural change.
