# Critical audit — Layer 2 patches contract is unwired

**Trigger:** the `/eval-agent` measurement layer (`bench/design/eval/`) ran the design audit against the world-class corpus and surfaced two anomalies:
- `auditResultV2` missing from `report.json` even on stripe.com / linear.app
- `designAudit_patches_valid_rate` = unmeasured because zero findings emit patches

**Score: 5/10.**

The Layer 2 patches contract from PR #81 shipped 421 lines of TypeScript primitives + 21 unit tests — but **the production audit prompt was never updated to ask the LLM for patches**. Three independent unwired connections all in the same direction: scaffold landed, wire-up never did. 1503 unit tests passing didn't catch this; the eval did in 5 seconds.

The pieces are correct. The wiring is missing.

## Fix plan (HIGH first)

1. **[HIGH] `src/design/audit/v2/score.ts:42`** — v2 LLM prompt does not request patches.
   **Action:** Extend `buildEvalPromptV2` response schema to include `patches: Patch[]` per finding (major/critical only). Document the exact `Patch` shape; show one worked example.
   **Verification:** `pnpm design:eval:calibration`; confirm `auditResultV2.findings[*].patches.length > 0` on at least one site.

2. **[HIGH] `src/design/audit/v2/build-result.ts:135`** — `patches: []` is hardcoded.
   **Action:** After v2 LLM parse, run `parsePatches → validatePatch → enforcePatchPolicy`. Replace line 135's literal with the validated array.
   **Verification:** Unit test asserting valid patch survives, invalid one filtered, and major-without-valid-patch downgraded to minor.

3. **[HIGH] `src/design/audit/pipeline.ts:212`** — v2 gated on `ensemble`, undefined when `profileOverride` is set.
   **Action:** Synthesize a single-signal `EnsembleClassification` from the override so v2 runs unconditionally.
   **Verification:** Re-run `pnpm design:eval:calibration --tier world-class`; confirm `auditResultV2` present on every report.json.

4. **[MEDIUM] `bench/design/eval/patches.ts`** — eval correctly reports `unmeasured`; no code change. Re-run after #1-3.

5. **[LOW] `src/design/audit/patches/severity-enforcement.ts`** — wired automatically by Fix #2; verify with grep.

## Dispatch-at-end

Fix the three HIGH findings in order: 1 (prompt) → 2 (parse + enforce) → 3 (profile override). Then run `pnpm design:eval:calibration` and `pnpm design:eval --patches-only --roots bench/design/eval/results/run-<latest>/calibration` to re-baseline. Re-run `/critical-audit --reaudit` against this run to verify all HIGH findings are `resolved`. Until that's clean, the entire content-engine surface (jobs / reports / brand-evolution / orchestrator) is operating on partial audit output.
