# Eval Rigor — Canonical Validation Protocol

This is the **only** way to validate a change in this repo. Bypassing it has caused three single-run overclaims (Gen 4, Gen 6, Gen 7). The CLAUDE.md `Measurement Rigor` section is the law; this doc is the operating manual.

## The Four Tools

There are four sanctioned validation paths. **Anything that doesn't go through one of them does not produce a result that can be cited in a PR, changeset, pursuit doc, or progress.md.**

| Tool | Use when | Reps | Output |
|---|---|---|---|
| `pnpm bench:validate` | You want to check that a single config is stable / measure its mean | ≥3 (enforced) | `multi-rep-summary.{json,md}` with mean/min/max |
| `pnpm ab:experiment` | You want to compare two `bad` configs (baseline vs challenger) | ≥3 (≥10 for promotion) | `summary.json` with Wilson CIs and bootstrap delta CI |
| `pnpm research:pipeline --two-stage` | You have a queue of hypotheses to screen and the winners need rigorous validation | 1 screen + 5 validate | `summary.{json,md}` per hypothesis |
| `pnpm bench:compete` | You want to compare `bad` against another framework (browser-use, Stagehand, …) | ≥3 (enforced) | `summary.json` + `comparison.md` with Wilson CIs, bootstrap CIs, Cohen's d, Mann-Whitney U, spread-test verdict per metric |

## Hard Rules (from CLAUDE.md `Measurement Rigor`)

1. **No single-run claims. Ever.** ≥3 reps for any speed/turn/cost claim. `bench:validate` exits non-zero if you pass `--reps < 3` without `--allow-quick-check`, and `--allow-quick-check` runs may NOT be cited.
2. **Spread test:** If `(challenger_mean − baseline_mean)` is less than the worst-case spread of either side, the result is **"comparable"**, not an improvement.
3. **Re-measure baselines under the same conditions** (same scenario, same model, same day, same machine). Stale baselines from prior generations are reference points, not promotion gates.
4. **Cost claims still need ≥3 reps.** Per-call token count is deterministic, but the *number* of LLM calls per run is variable.
5. **Quality wins (pass-rate) need ≥5 reps** because pass/fail is binary and a single flake swings the rate by 20% on a 5-case set.
6. **Big wins (>3× best-known baseline) require ≥5 reps before being written down anywhere** — that's the regime where variance hides.
7. **PR / changeset / pursuit doc must all carry the same multi-rep numbers.** Overstated numbers in a shipped changeset are a release-blocker, not a "fix in next gen."

## Canonical Commands

### Single-config variance check (most common during development)

```bash
pnpm bench:validate \
  --cases bench/scenarios/cases/local-long-form.json \
  --config bench/scenarios/configs/planner-on.mjs \
  --reps 3 \
  --modes fast-explore \
  --label gen7-planner \
  --out agent-results/multi-rep-gen7-planner
```

Output: `agent-results/multi-rep-gen7-planner/multi-rep-summary.md` — paste this directly into the PR description.

### A/B comparison (promotion-grade)

```bash
pnpm ab:experiment -- \
  --cases bench/scenarios/cases/local-long-form.json \
  --off-config bench/scenarios/configs/planner-off.mjs \
  --on-config bench/scenarios/configs/planner-on.mjs \
  --repetitions 10 \
  --modes fast-explore \
  --out agent-results/ab-gen7-planner
```

Output: `summary.json` (Wilson CIs, bootstrap delta CI), `summary.md`, `runs.csv`. Promote only when the bootstrap CI **lower bound is positive**.

### Two-stage hypothesis screening

```bash
pnpm research:pipeline --queue bench/research/<queue>.json --two-stage
```

1 rep screens all hypotheses, then 5 reps validate the candidates. ~40% cheaper than flat runs.

## The Summary Table Format (use verbatim)

Every PR description, changeset, and pursuit doc that claims a metric movement uses this table:

```
| metric        | baseline (mean) | challenger (mean) | Δ      | reps | min/max challenger | verdict    |
|---------------|-----------------|-------------------|--------|------|--------------------|------------|
| wall-time     | 53s             | 50s               | -3s    | 3    | 35s / 75s          | comparable |
| LLM calls     | 9               | 10.5              | +1.5   | 3    | 7 / 16             | comparable |
| $ per run     | $0.89           | $0.30             | -$0.59 | 3    | $0.22 / $0.41      | win        |
```

Verdicts: `win` (delta > worst-case spread, in the right direction) · `comparable` (delta within spread) · `regression` (delta > worst-case spread, in the wrong direction).

## Anti-patterns (do not do these)

- ❌ `for i in 1 2 3; do node dist/cli.js ...; done` — bypass of the harness, output not standardized, no JSON aggregation.
- ❌ "I ran it once and it was 31s, that's a 5.8× speedup" — single run.
- ❌ Citing best-case alone — `--label "fastest run"`.
- ❌ Reusing a baseline number from a prior generation — re-measure on the same day.
- ❌ Updating the changeset only after merge — the changeset on the branch is the artifact that ships.
- ❌ "Mechanism is sound, I'm confident" — confidence is not validation. Reps are.

## What rigorous failure looks like

Gen 7 was caught here. The single-run claim was 31s (5.8× speedup). The 4-rep mean was 50s with 35s–75s spread — comparable to Gen 6.1's 53s baseline, not 2× better. Cost was the actual win (~3× cheaper because plan calls hit prompt cache). The PR was rewritten with the honest table BEFORE merge.

This is the failure mode the rigor rules exist to prevent.
