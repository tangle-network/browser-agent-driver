# Pursuit: Comprehensive benchmark — Gen 11
Generation: 11 (benchmark infrastructure, not agent runtime)
Date: 2026-04-09
Status: designing
Branch: gen11-comprehensive-benchmark

## Thesis

Gen 4-10 shipped progressively faster, smarter agent code. **Gen 11 ships the truth table that shows where `bad` actually stands.** Every public claim ("7× faster than browser-use", "Gen 10 fixes npm and w3c", etc.) needs to come from a single, reproducible, multi-tier benchmark with same-day matched baselines, ≥5 reps for pass-rate claims, and an LLM judge for trajectories. The shipping artifact is `agent-results/master-comparison-<timestamp>/REPORT.md` plus `scripts/run-master-comparison.mjs` to reproduce it.

This is NOT an agent runtime change. The agent stays at Gen 10. The "generation" is the **benchmark infrastructure**: a unified runner that walks every tier we have, plus an aggregation script that produces a single honest report.

## System Audit

### What exists and works (verified by Phase 0 audit)

| Surface | Status | Evidence |
|---|---|---|
| `pnpm bench:compete` (cross-framework) | ✅ wired, statistically rigorous (Wilson CI, bootstrap CI, Cohen's d, MWU) | `scripts/run-competitive.mjs` |
| `bench/competitive/adapters/browser-use.mjs` | ✅ functional | `_browser_use_runner.py` Python bridge |
| **browser-use 0.12.6 in `.venv-browseruse`** | ✅ verified importable (`from browser_use import Agent`) | live shell check |
| 10 real-web tasks in `bench/competitive/tasks/real-web/` | ✅ exist + Gen 10 5-rep validated | `gen10-5rep-cherrypick-1775699248/` |
| `pnpm bench:webvoyager` | ✅ runner exists, downloads on demand | `bench/external/webvoyager/run.mjs` |
| **WebVoyager data: 590 valid tasks across 15+ sites** | ✅ downloaded, converted, cached | `bench/external/webvoyager/cases.json` (276K) |
| `pnpm bench:tier1:gate` (deterministic local) | ✅ passing | `agent-results/tier1-gate-1775697547090/` |
| `pnpm bench:validate` (multi-rep stability) | ✅ wired | `scripts/run-multi-rep.mjs` |
| `pnpm ab:experiment` (config A/B) | ✅ wired | `scripts/run-ab-experiment.mjs` |

### What exists but isn't integrated

- **Master orchestration**: no `bench:everything` / `bench:master` script. Each runner emits its own JSON shape; no aggregator pulls them together.
- **Cross-bench comparison report**: `comparison.md` exists per-runner; no unified report across runners.
- **Multi-model truth table**: `--model` flag exists everywhere but no spec runs the same gauntlet on multiple models for an apples-to-apples reasoning-quality comparison.
- **WebVoyager 30-task representative subset**: 590 tasks exist but no curated "diverse 30" subset for a meaningful 30-min sample.

### What was tested and failed (or not yet attempted)

- **Stagehand adapter**: stub at `bench/competitive/adapters/stagehand.mjs`. Returns `success: false` on `runTask`. Would need a `_stagehand_runner.ts` to be useful. **Defer to Gen 12.**
- **WebArena**: requires Docker + 50 GB + 7 ports. Multi-hour setup. **Defer to a separate session.**
- **Wallet gauntlet**: requires Anvil boot + extension onboarding (~10 min setup). 7/7 known-pass. **Defer — orthogonal to the question Drew asked, which is "how do we compare on the WEB".**
- **Anthropic Claude models**: no `ANTHROPIC_API_KEY` in `.env`. Multi-model comparison is **OpenAI-only** (gpt-5.2 vs gpt-5.4).

### What doesn't exist yet

- An orchestration script that walks every runnable tier
- A unified report format aggregating per-tier outputs
- A curated 30-task WebVoyager subset (needs construction: 3 tasks per site × 10 sites)
- A clear "headline number" framing across tiers (cost-per-pass, p95 latency, judge agreement)

### User feedback (this turn)

> "this rigorous benchmark to get really everything aboslutely covered and benched, all benchmarks, don't hold back, no fake shit, really dive into the challnege and let's go!"

The directive is unambiguous: comprehensive coverage, real numbers, rigor protocol enforced. Not a sales pitch — an honest truth table.

### Measurement gaps

- **No post-Gen-10 head-to-head**: existing `gauntlet-headtohead-2026-04-08/` is Gen 8 vs browser-use. Gen 10 changed the agent significantly; the head-to-head must be re-run.
- **No published-benchmark legitimacy**: WebVoyager has never been run with bad. Browser-use has published numbers there; we should too.
- **No multi-model truth table**: bad is run on gpt-5.2 by default. How does gpt-5.4 (smarter, more expensive) compare on the same tasks?
- **No cost-per-pass tracking**: every report shows raw cost, but the honest framing for "we're +59% on cost but +16pp on pass rate" is cost-per-pass = +28%. Reports should show this directly.

## Current Baselines (verified, same-day or recent)

| Surface | Result | Source | Date |
|---|---|---|---|
| Gen 10 5-rep real-web | 37/50 = 74% | `gen10-5rep-cherrypick-1775699248/` | 2026-04-09 |
| Gen 8 5-rep real-web (same-day) | 29/50 = 58% | `/tmp/bad-gen8-baseline/agent-results/gen8-sameday-5rep-1775699818/` | 2026-04-09 |
| Pre-Gen-10 head-to-head (3-rep) | bad 23/30 = 77% vs browser-use 25/30 = 83% | `gauntlet-headtohead-2026-04-08/` | 2026-04-08 |
| Tier 1 deterministic gate | 2/2 = 100% | `tier1-gate-1775697547090/` | 2026-04-09 |
| Gen 10 mean cost | $0.0272 | gen10 5-rep | 2026-04-09 |
| browser-use mean cost (Gen 8 era) | $0.0280 | head-to-head | 2026-04-08 |
| WebVoyager | NEVER RUN | n/a | n/a |
| Multi-model | NEVER RUN | n/a | n/a |

## Diagnosis

The "current state" is unambiguous: **we have agent code shipping faster than we can validate it externally.** Gen 4 → Gen 10 produced a 5.8× speedup, +16pp pass rate, and a fundamentally different action vocabulary (`extractWithIndex`), but the only cross-framework comparison we have is from Gen 8. The bottleneck is **measurement coverage**, not agent capability.

**Architectural vs tunable**: this is architectural — we need a *new measurement surface* (the master orchestrator + report) that doesn't currently exist. Tweaking existing runners individually is `/evolve` work; building a unified comparison harness is `/pursue` work.

---

## Generation 11 Design

### Thesis
**Build a single 90-minute, ~$15 master comparison run that produces an honest, reproducible truth table across every benchmark surface that's runnable today, and ship the orchestrator + report as the artifact.**

### Changes (ordered by impact)

#### Architectural (must ship together)

1. **`scripts/run-master-comparison.mjs`** — orchestration script that walks every tier in priority order, captures structured output, and writes a unified report. Resumable (skip tiers with existing data via `--skip-existing`). Risk: low — pure orchestration, no agent runtime changes.

2. **30-task WebVoyager curated subset** — `bench/external/webvoyager/curated-30.json` with 3 tasks per site across 10 representative sites (Wolfram Alpha, Cambridge Dictionary, ArXiv, ESPN, Allrecipes, Booking, GitHub, BBC, Wikipedia, HuggingFace). Diverse, fast to run, statistically meaningful.

3. **Report aggregator** — function inside the orchestrator that reads each tier's JSON output and emits `agent-results/master-comparison-<timestamp>/REPORT.md`. Sections: Executive Summary, Per-Tier Results, Cross-Framework Truth Table, Cross-Model Truth Table, Cost Analysis, Honest Weak Spots, Reproducibility.

#### Measurement (eval changes)

4. **Cost-per-pass headline metric** — every comparison report includes both raw cost AND cost-per-pass. The latter is the honest framing when pass rates differ.

5. **Wilson 95% CI on pass rates** — already exists in `scripts/lib/stats.mjs`; surface it in the master report.

#### Infrastructure (reliability, observability)

6. **Tier-by-tier launch + capture** — orchestrator launches each tier as a child process, captures its summary JSON, and aggregates. If a tier crashes, the others continue.

7. **Cumulative cost guard** — orchestrator tracks running cost across tiers and warns if approaching $20.

### Tier plan (ordered by priority)

#### Tier A: cross-framework gauntlet (THE headline)
- **bad Gen 10 vs browser-use 0.12.6**
- **5 reps × 10 tasks × 2 frameworks = 100 runs**
- Same model (gpt-5.2), same conditions
- Expected wall-clock: bad ~13s/run × 50 = 11 min; browser-use ~65s/run × 50 = 54 min → **~70 min total** (sequential), parallelize via concurrency to ~30 min
- Expected cost: bad $0.027 × 50 = $1.35; browser-use $0.028 × 50 = $1.40 → **~$3 total**
- Output: pass-rate delta with Wilson CI, cost-per-pass, per-task breakdown, video evidence dashboard
- **This is the answer to "where do we stand vs browser-use post-Gen-10"**

#### Tier B: WebVoyager 30-task curated sample
- **bad Gen 10 only on a curated diverse 30-task sample** (3 per site × 10 sites)
- LLM judge (GPT-4o vision) for trajectory scoring
- Expected wall-clock: ~30 min at concurrency=3
- Expected cost: ~$8 (run + judge)
- Output: WebVoyager pass rate, judge agreement rate, per-site breakdown
- **This is the published-benchmark legitimacy**

#### Tier C: multi-model on the gauntlet
- **bad Gen 10 on gpt-5.4 (3-rep)**, compared against the existing gen10-5rep on gpt-5.2
- Same 10 tasks, same conditions
- Expected wall-clock: ~15 min (gpt-5.4 is faster than gpt-5.2)
- Expected cost: ~$2-4 (gpt-5.4 is more expensive per token but uses fewer tokens)
- Output: per-model pass rate, cost, wall-time
- Anthropic skipped (no API key)
- **This shows whether spending more on a smarter model materially helps**

#### Tier D: Tier 1 deterministic gate (regression check)
- **bad Gen 10 on the deterministic local fixtures**
- Expected wall-clock: ~1 min
- Expected cost: ~$0.30
- Output: pass=true/false, regression check
- **This proves we didn't break the deterministic baseline while chasing the real-web wins**

### Total budget envelope
- **Wall-clock**: ~90 min (Tiers A and B can run in parallel; C and D are quick)
- **Cost**: ~$15 (~$3 cross-framework + $8 WebVoyager + $4 multi-model + $0.30 tier 1)
- **Hard cost cap**: orchestrator aborts if cumulative cost exceeds $25

### Alternatives considered

- **Run all 590 WebVoyager tasks** — rejected: $162, 10 hours. The 30-task curated subset gives the same statistical power for most claims at 6% the cost.
- **Include WebArena** — rejected: requires Docker + 50GB + 7 ports + day of setup. Defer to a dedicated session.
- **Include wallet gauntlet** — rejected: orthogonal to the question Drew asked (web comparison, not DeFi). Defer.
- **Include Anthropic Claude in multi-model** — rejected: no API key in `.env`. Add to Gen 12 if the key gets provisioned.
- **Add Stagehand to cross-framework** — rejected: adapter is a stub, would need a `_stagehand_runner.ts` build. Defer to Gen 12.
- **Run Tier 3 (open-web reachable)** — rejected: overlaps with Tier A (real-web tasks). The Tier A 10-task gauntlet already covers open web.

### Risk assessment

| risk | likelihood | impact | mitigation |
|---|---|---|---|
| browser-use 5-rep takes >2 hours | medium | wall-clock blowout | Run Tier B (WebVoyager) in parallel |
| WebVoyager LLM judge cost spikes | low | budget overrun | `--estimate` flag first; cap at $10 |
| One framework crashes mid-run | low | partial data | Orchestrator continues other tiers |
| OpenAI rate limits during Tier A + B parallel | medium | slower runs | Reduce concurrency; sequential fallback |
| `.env` API key missing for some path | low | tier crashes | Pre-flight check before launch |
| Cumulative cost > $25 | low | budget overrun | Hard cap in orchestrator |

**Reversibility**: ALL changes are additive (new script, new task subset, new report). No agent runtime changes. No risk to existing benchmarks. Rollback = `git revert <pr-sha>`.

### Success criteria

1. **REPORT.md exists** with Executive Summary, all 4 tier results, cross-framework table, cross-model table, cost analysis, honest weak spots
2. **Tier A produces a clean head-to-head** with Wilson CI on the delta and cost-per-pass for both frameworks
3. **Tier B produces a real WebVoyager number** (judge pass rate + judge agreement) on a 30-task curated sample
4. **Tier C produces a per-model truth table** for at least gpt-5.2 vs gpt-5.4
5. **Tier D passes** (Tier 1 deterministic gate green = no regression)
6. **Reproducible**: someone running `pnpm bench:master` against the same git sha produces a directionally identical report
7. **All numbers cited in REPORT.md come from real runs in this session**, not from prior reference data

### What "shipped" looks like

A PR that merges:
1. `scripts/run-master-comparison.mjs` (~200 LOC orchestrator)
2. `bench/external/webvoyager/curated-30.json` (30 task IDs picked by hand)
3. `package.json` script `bench:master`
4. `agent-results/master-comparison-<timestamp>/REPORT.md` (the headline artifact)
5. `agent-results/master-comparison-<timestamp>/<tier>/...` (raw per-tier data for reproduction)
6. Updated `docs/COMPETITIVE-EVAL.md` linking to the master report
7. Updated `.evolve/{progress.md,current.json,experiments.jsonl}` with Gen 11 result

If any tier reveals a regression, the report says so honestly. **No reward-hacking, no shortcuts. No claims that aren't backed by ≥5 reps and same-day baselines.**

## Build status

| # | Change | Status | Files | Tests |
|---|---|---|---|---|
| 1 | scripts/run-master-comparison.mjs | ❌ to build | new file | n/a (orchestration) |
| 2 | bench/external/webvoyager/curated-30.json | ❌ to build | new file | n/a (data) |
| 3 | package.json `bench:master` script | ❌ to add | edit | n/a |
| 4 | Run Tier A (cross-framework 5-rep) | ❌ to run | output: agent-results/ | empirical |
| 5 | Run Tier B (WebVoyager 30) | ❌ to run | output: agent-results/ | empirical |
| 6 | Run Tier C (multi-model) | ❌ to run | output: agent-results/ | empirical |
| 7 | Run Tier D (Tier 1 gate) | ❌ to run | output: agent-results/ | empirical |
| 8 | Aggregate into REPORT.md | ❌ to build | output: agent-results/ | manual review |
| 9 | Persist .evolve/ + commit + PR | ❌ to do | various | n/a |

## Phase plan
- **Phase 1: Design** ← we are here, writing this spec
- **Phase 2: Build** orchestrator + curated-30 subset (~30 min)
- **Phase 3: Test** — launch all tiers (~90 min wall-clock, parallel where possible)
- **Phase 4: Evaluate** — read every output, write REPORT.md with honest assessment
- **Phase 5: Persist** — commit, PR, update .evolve/

## Next: build orchestrator + curated subset, then launch
