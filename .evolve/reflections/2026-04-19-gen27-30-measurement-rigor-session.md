# Reflect: Gen 27-30 — The Measurement-Rigor Arc
Date: 2026-04-19
Dispatched by: /governor (≥5 rounds since 2026-04-10, active gains + exploit queued)

## Context

5 shipments since the last reflection (2026-04-10 gen13-26-vision-session):

| Gen | Theme | Scale | Date |
|---|---|---|---|
| 27 | stealth + anti-bot + system Chrome + mouse humanization | ~6 commits | 2026-04-11 |
| 28 | per-role model orchestration | 1 commit | 2026-04-12 |
| 29 | browser-harness integration (attach, domain skills, macros, eval-gated promotion) | 29 files / 2832 lines / 78 tests | 2026-04-18 |
| 30 R1 | bootstrap CI + Cohen's d for macro promotion verdict | 7 files / 299 lines / 21 tests | 2026-04-19 |
| 30 R2 | Tangle router unblock + Gen 29 non-regression proof + 13% cost win | 7 files / 117 lines | 2026-04-19 |

## Run Grade: 7.5/10

| Dimension | Score | Evidence |
|---|---|---|
| Goal achievement | 8 | Gen 27 closed the anti-bot gap (+9 previously-blocked sites). Gen 29 shipped the moonshot browser-harness had hyped, with measurement rigor underneath it. Gen 30 R2 produced the first statistically valid cost win on this branch. |
| Code quality | 8 | 1015 → 1099 tests (+84 net new across Gen 29 + 30). Real-TCP-listener probe test added to attach path (correcting a mock-heavy starting point flagged by the audit). Typecheck + boundaries held green throughout. |
| Efficiency | 6 | Gen 29 was essentially a /pursue inside an /evolve session, done in one PR — correct call for scope, but the critical-audit caught 4 CRITICAL + 5 merge-blocker HIGH that required in-PR fixes. Gen 30 R2 lost ~40% of wallclock to discovering/fixing **two separate plumbing bugs** before the A/B could even produce valid data. |
| Self-correction | 9 | Corrected the initial "reject bh's self-healing" framing when Drew pushed back with "are you really thinking about these differences properly?" — reframed as complementary primitives, not competing approaches. Audit→fix→re-audit cycle landed cleanly in-PR. |
| Learning | 7 | Gen 30 R1 → R2 dogfooding is a new pattern worth naming. But: scorecard.json has been lying for 26 generations, `.evolve/critical-audit/` was never populated despite dispatching `/critical-audit`, and the Gen 29 audit findings live only in conversation history. Measurement of our own measurement is behind. |
| Overall | 7.5 | The direction is strong — we're on a measurement-rigor arc that competitors (browser-use) don't have. But the meta-loop persistence is weaker than the code quality. |

## The Six Patterns (from the dispatch brief)

### 1. Gen 29 competitor-triggered framing — initial dismiss, corrected by pushback

**Chronology:**
- 2026-04-17: browser-use/browser-harness shipped (466★ in 2 days)
- 2026-04-18: Drew shared the link, asked "audit and review this against ours"
- My first pass: "they're a minimal Python wrapper, we reject their self-healing pattern as incompatible with our rigor"
- Drew's pushback verbatim: *"are you sure you're really thinking about these differences properly? How are they complementary, moonshots am I missing what you're thinking?"*
- My corrected pass: "they're orthogonal — we have the harder half (eval rigor), they have the easier half (runtime capability growth). Union is the moonshot."
- Drew: "yea do it... all of this, all the work we think is valuable right now, in one pr, /pursue it"

**What the corrected framing unlocked:**
- 29 files, 2832 LOC, 78 tests — all in a coherent generation
- Three bh primitives (attach, domain skills, mutable tool surface) landed with measurement gates where they had zero
- The pursuit doc explicitly rejected the raw-TS-handler moonshot in favor of macro-DSL (60% of value, 5% of risk) — honest scope discipline

**What the failed first pass would have cost:**
If I'd shipped the "dismiss as toy" framing, we'd have missed the attach-to-real-Chrome UX win and the domain-skills-as-markdown layout — both of which make bad more useful to Drew's actual workflows today.

**Pattern to keep:** When a competitor ships a differently-shaped primitive, the first question is **"what's the union?"** not **"why are they wrong?"** Drew's taste filter catches this when I miss it. The anti-pattern isn't "taking competitors seriously" — it's treating "we do it differently" as an answer when it's only the setup to the answer.

### 2. Gen 30 R2 dogfooded Gen 30 R1's own verdict logic

Gen 30 R1 shipped bootstrap CI + Cohen's d in `scripts/lib/macro-promotion.mjs:decideVerdict` to address critical-audit finding B-H2 (Gen 29's first-order spread-dominance was false-promote fodder).

Gen 30 R2 immediately used it on the macros-ON vs macros-OFF A/B:

```
turns:  CI95 [-5, +3]       d = -0.29 (small)  → noise-dominated
cost:   CI95 [-$0.06, -$0.02] d = -2.57 (large) → confident win
verdict: promote
```

The verdict logic **correctly separated** the robust cost signal from the noise-dominated turn signal. If we'd shipped Gen 29's spread-dominance check, the cost win at mean −$0.04 would have squeaked through as `inconclusive` (spread was $0.06 on one side). The bootstrap CI's tighter confidence bound is what made the real call.

**Pattern to name:** *Dogfood the measurement infra on the thing you just shipped.* The infra that can't measure your current diff is infra that'll rot before it's trusted. Every measurement generation should find its first real-world test case within the same session, not in the next generation.

**Contra-example this exposes:** scorecard.json is the inverse — Gen 4 era metrics on Gen 30 work. It was never dogfooded because the flow that writes it was never wired into /evolve's round-shipped step.

### 3. critical-audit → fix-in-PR → re-audit is working (with one process gap)

Gen 29 `/critical-audit --diff-only` ran 3 serial reviewers in ~7 minutes. Findings:
- 4 CRITICAL (rootDir Windows bug, macro-name path traversal, compound-goal parallel tab bypass, mock-heavy attach tests)
- 5 merge-blocker HIGH (probe body hang, Chrome zombie, SIGINT leak, invalid promotion stats, silent attach fallback)

**All** CRITICAL and merge-blocker HIGH were fixed in the same PR (b7bb65d + 5d2ddba + 6d23efd). The audit feedback became Gen 30 R1's target.

**Pattern working:** the audit is a feed for /evolve. The loop is pursue → audit → next-gen-targets-the-audit-findings. This is cheaper than discovering the same findings post-merge via bug reports.

**Process gap:** **`.evolve/critical-audit/<ts>/` was never populated.** The skill's own spec says to write `manifest.json` + `findings.jsonl` + `summary.md`. I dispatched the skill and addressed the findings inline, but never persisted the audit to durable state. Six months from now, nobody can answer "what did Gen 29's audit find?" without spelunking git history. This is an own-goal: the eval rigor we're proud of doesn't extend to our own reflective loop.

**Fix:** critical-audit needs an enforcement step — the skill must verify it wrote to `.evolve/critical-audit/<ts>/` before dispatching back. Or the wrapper in `/pursue` Phase 3.5 needs to check this post-hoc.

### 4. Measurement-plumbing debt is a real, compounding pattern

Gen 30 R2 needed **two separate infra fixes** before the LLM A/B could produce valid data:

| Bug | Wasted wallclock | Surfaced by |
|---|---|---|
| `scripts/run-multi-rep.mjs` didn't forward `--provider` / `--base-url` / `--api-key` to the child `bad run` process | ~5 min (first 3-rep failed with 401 "Incorrect API key") | Me inspecting the failed rep's verdict |
| `router.tangle.tools` defaults `stream: true` when field absent; AI SDK's `generateText` can't parse SSE — "Invalid JSON response" | ~15 min (second 3-rep failed after infra fix #1) | Me reading events.jsonl + direct curl probe |

Both are single-session bugs a provider-compatibility smoke would have caught in 30 seconds.

**Third instance same week:** Gen 29 shipped the attach path with `--attach` / `--cdp-url` / `--attach-port` flags, but the wallet-mode incompatibility wasn't enforced until the audit flagged it. Another plumbing bug.

**The compounding:** every new provider / model / measurement surface adds plumbing debt the first time it's exercised. The debt is invisible until a real run tries to cross it.

**Fix:** `scripts/provider-compat-smoke.mjs` — a 1-turn test matrix that exercises every supported `(provider, baseUrl, model)` combination with a trivial goal. Runs in CI. Catches regressions before a 3-rep multi-rep burns 5 minutes discovering them.

### 5. scorecard.json is Gen 4 (2026-04-07) — 26 generations stale

Looking at it:

```json
{
  "generation": 4,
  "evolveRound": 1,
  "flows": [
    "verifyEffect_click_overhead_ms", "cursor_overlay_click_overhead_ms",
    "tier1_full_evidence_pass_rate", "tier1_fast_explore_pass_rate",
    ...
  ]
}
```

No flow reflects any Gen 13-30 work. Nothing tracks WebVoyager pass rate, cost-per-run, stealth bypass rate, macro-promotion verdicts, or the Gen 30 R2 cost delta.

**Root cause:** the file is hand-written. There's no script that derives current flows from experiments.jsonl + current bench runs. /evolve's dispatch-at-end updates `current.json` and appends to experiments.jsonl but doesn't touch scorecard.json.

**Process-level fix:**
- `scripts/update-scorecard.mjs` reads the last N rounds' experiment entries, extracts canonical metrics (WebVoyager pass rate, cost per run, tier1 gate, macro promotion-rate), and writes scorecard.json.
- Hook into the evolve dispatch-at-end: every round that emits a "round-shipped" event also updates scorecard.
- /governor's Phase 1 reads this file — a stale scorecard means /governor is guessing from Gen-4-era signals. Shipping this unblocks future governor runs.

**Blast radius if left rotten:** every /governor invocation reads a lying scorecard. "Below target with movable metric" signal cannot fire because no flow has a current score. This is a latent bug in the explore-exploit loop that will cause governor to under-index on exploits.

### 6. WebVoyager 590 measurement debt — compounded across 9 generations

`current.json` says verbatim: *"No full WebVoyager 590 run since Gen 25; 9 generations pending measurement."*

**Cost math:**
- Gen 25 was $54 on gpt-5.4 at 590 tasks
- Gen 30 R2 showed claude-sonnet-4-6 via Tangle router is ~13% cheaper than OpenAI gpt-5.4 on local-smoke (cost $0.27 vs $0.31)
- Full 590: ~$47-54 range. Maybe 2 hours wall-clock.

**Real blocker wasn't cost** — it was setup friction. Every attempted run before today hit:
- OpenAI quota exhausted on this machine (Gen 30 R1 descope reason)
- Infra plumbing bugs (Gen 30 R2's --base-url forwarding + stream:false wrapper)
- No funded key for the full run

Now that Tangle router works end-to-end (R2 proved it), there's no reason not to queue a full 590 run. Every claim about Gen 26-30 WebVoyager performance is currently unverifiable — including the headline *"91.3% from Gen 25, estimated 93-96% with Gen 27."*

**This is the highest-ROI action available.** Running it (a) proves (or refutes) non-regression at scale on real-web tasks (b) gives a current publishable number for the PR/README (c) unblocks the "Gen 30 R3: curated-30 A/B" hand-off that was queued.

## Session Flow Analysis

```
FLOW: Drew spots competitor → asks me to audit → I dismiss → Drew pushes back → I reframe as union → Drew says "ship it" → I /pursue
Frequency: 1 (Gen 29)
Automation: the push-back step is Drew's taste filter. Can't automate. But I can
  pre-empt: on any "audit this external thing" request, my first output should
  be the union-framing, not the compare-and-contrast framing.

FLOW: /pursue generation ships → /critical-audit --diff-only → audit findings become next /evolve round's target
Frequency: 2 (Gen 29 → Gen 30 R1 closed B-H2; Gen 30 R1 → Gen 30 R2 closed descope)
Automation: this IS /pursue Phase 3.5 working as designed. Worth formalizing as
  the canonical post-pursue flow. But also: enforce the critical-audit persist
  step so findings live in .evolve/, not conversation history.

FLOW: I claim a cost/speed delta → Drew cites CLAUDE.md §Measurement Rigor → I realize single-run → run 3-rep → honest table
Frequency: 0 times in this session (I internalized the rule this session)
Automation: CLAUDE.md is the gate. The Gen 30 R1 verdict upgrade makes the
  gate harder to route around — even with the best intention, the verdict
  now requires min/max spread + large effect size to promote.

FLOW: discover infra bug → curl probe → minimal repro → fix → re-run measurement
Frequency: 3 times in Gen 30 R2 alone (--base-url plumbing, stream:false, then the A/B)
Automation: provider-compat-smoke script would have caught these in 30s.
  TODO: ship it before the next WebVoyager run.
```

## Operator Patterns (Drew, this session specifically)

Consistent behaviors seen in Gen 27-30:
- **Framing correction over solution correction** — Drew's biggest push-back was on *how I was thinking about competitors*, not on *what I was building*. The code-level feedback was all downstream of the framing win.
- **"Do all of this in one PR" shipping preference** — for genuinely coherent work, Drew wants one big diff, not staged micro-PRs. The Gen 29 PR was 2832 lines and that was correct scope.
- **Honest measurement fetish** — Drew's gate on any "we're faster / cheaper / better" claim is multi-rep data. The §Measurement Rigor section of CLAUDE.md is the most-enforced rule in the repo.
- **"Use $TOOL that's already here"** — instead of "build X for measurement," the Tangle router ask was "use the thing that already exists and unblocks this." Preference for reaching into existing infra before building new.
- **Infra blockers are acceptable answers** — Drew accepted "quota exhausted, descoped to Gen 30 R2" without pushing "work around it." Once I said "router works," he immediately wanted measurement through it. Distinguishes real blockers from excuses.

## Project Health

**Trajectory:** improving — Gen 27-30 is a coherent "measurement-rigor arc" after the Gen 13-26 "capability arc." Two adjacent halves of a coherent strategy.

**Test coverage:** 1099 tests, typecheck green, boundaries green, 85 test files. Real-infra tests added to attach path (previously mock-only). Macro dispatch is tested end-to-end. Promotion script has 18 tests across pure-logic + stubbed-subprocess E2E. **Coverage is meaningfully defending regressions** — not line-count theater.

**Architecture clean/debt:**
- Clean: extension system (bad.config, domain-skill loader, macro registry all flow through one ResolvedExtensions shape). CLI flag → config → child-script passthrough is now consistent after Gen 30 R2's forwarding fix.
- Debt: `src/brain/index.ts` is now 2700+ lines (up from 2500 at last reflection). Still not split. Gen 30 R2 added `createForceNonStreamingFetch` at the bottom of the file rather than extracting provider-setup code. Debt is accumulating.
- Latent: `scorecard.json` lying, `.evolve/critical-audit/` empty, WebVoyager 590 stale. Process-level debt, not code-level.

**Next highest-ROI action:** full WebVoyager 590 run via Tangle router + claude-sonnet-4-6. Eliminates the compounded measurement debt. Cost ~$47. Time ~2h. Output: a current honest number for Gen 30.

## Product Signals (refreshed from last reflection)

### Still valid from 2026-04-10 reflection
1. **Browser Research Agent** (Gen 21 parallel tabs is shipped — product capability exists now)
2. **Benchmark-as-a-Service** (bad-app could expose WebVoyager runs via API)
3. **Live Agent Viewer** (cursor overlay + SSE live view in `bad --live` are shipped — demo-ready)

### New signals from Gen 27-30
4. **Attach-to-real-Chrome as a power-user feature** — `bad --attach` preserves login state / cookies / extensions. This unblocks "automate my real LinkedIn / Gmail / TikTok" workflows that every sandboxed browser agent can't do. **Compelling as a pro-tier feature.**
5. **Eval-gated capability marketplace** — `skills/macros/` + `.evolve/candidates/macros/` is the scaffolding for a marketplace where users publish macros, the eval-gated promotion script runs baseline-vs-treatment A/B's, winners get broadcast. Every existing browser automation vendor ships "skills" without evals. **Moat.**
6. **Measurement infra as product for AI agent companies** — `scripts/lib/stats.mjs` + `scripts/run-multi-rep.mjs` + `scripts/lib/macro-promotion.mjs` together are a publishable eval harness for any agent shop with LLM traces. browser-use-harness (466★, 2 days) has zero of this. **Sellable.**

## Proposed Automations (ordered by impact)

### 1. `scripts/update-scorecard.mjs` + evolve hook
- Reads last 20 experiments.jsonl entries, derives current flows from verdicts
- Hooks into /evolve dispatch-at-end
- Keeps /governor's signal detection from lying
- ~40 lines of code + a hook
- Fixes: scorecard-stale (blocks /governor's below-target-movable signal)

### 2. `scripts/provider-compat-smoke.mjs`
- Matrix of (provider, baseUrl, model) → 1-turn smoke
- Catches plumbing debt before real measurement runs burn 5 minutes
- Runs in pnpm test's "quick" path or as a pre-flight gate for multi-rep
- ~100 lines
- Fixes: Gen 30 R2-style wallclock losses

### 3. critical-audit persist enforcement
- Skill must verify it wrote `.evolve/critical-audit/<ts>/manifest.json` before returning
- OR `/pursue` Phase 3.5 wrapper checks post-hoc and refuses to continue if missing
- Fixes: Gen 29 audit findings only live in conversation history

### 4. Nightly WebVoyager 590 as cron
- Every night, run full 590 on main against baseline
- Alert on regression via Slack/Linear
- Closes the "9 generations pending measurement" loop structurally
- Once shipped, criticalGap in current.json can become "last run 2026-04-20, 92.4%, +1.1pp vs Gen 25"
- Uses Tangle router + claude-sonnet-4-6 (~$47/night)

### 5. `research/` decision records for the reflection corpus
- `/capture-decisions` skill exists but hasn't been used on this session's major pivots
- The "dismiss→reframe→union" pattern from Gen 29 is the kind of decision worth capturing for future reflect sessions
- ~2 decision records per generation going forward

## Cross-Project Patterns (this is a single-project reflect, placeholder for next portfolio reflect)

Patterns likely to appear elsewhere in Drew's portfolio:
- Measurement-plumbing debt compounds until a real run exposes it (almost certainly true of ai.tangle.tools agent evals)
- scorecard.json-style human-authored metrics rot faster than machine-derived ones
- audit→fix-in-PR works; the missing half is persist-the-audit-findings-to-durable-state

Portfolio reflect after next /governor invocation: cross-check against `~/.claude/reflections/INDEX.md` to see if these patterns repeat.

## The Generational Leap Gen 27-30 Suggests

The arc:
- Gen 13-26 = capability (make the agent more capable: vision, planner, SoM, parallel tabs)
- Gen 27-30 = trust (make the meta-loop trustworthy: stealth, per-role cost, self-healing with eval, bootstrap CI)

**Gen 31 candidate A: agent-as-judge.** Use the agent to evaluate its own runs post-hoc. Generate a "what should have happened" trajectory from the goal + final state, compare to actual, score the delta. Unlocks targeted improvement without a human in the loop. This is /eval-agent applied to bad's own output.

**Gen 31 candidate B: persistent-browser-session / long-running tasks.** Gen 29's `--attach` primitive is the seed. Build on it: stateful memory across sessions, checkpoint + resume across days, long-running tasks ("monitor this site daily and alert on change"). The "employee" framing Drew raised during the Gen 29 conversation.

**Gen 31 candidate C: productize the eval-gated skill marketplace.** `skills/macros/` + `skills/domain/` already exist with eval-gating. Ship a `bad publish <macro>` / `bad install <macro>` CLI. Make the moat a social layer, not just an architectural one.

**My read:** candidate B is the highest-ROI. The measurement arc (Gen 27-30) gives us the trust to ship a long-running-agent feature without the reliability risk. Candidate A is good but belongs inside B (a judge that scores the long-running trajectory). Candidate C is great but blocked on (B) — there needs to be meaningful work for the skills to do before publishing them is useful.

## Action Items (ordered by impact)

1. **Full WebVoyager 590 run** via Tangle router + claude-sonnet-4-6. Queue tonight. Eliminates 9-gen measurement debt.
2. **Ship scripts/update-scorecard.mjs + evolve hook.** Unblocks /governor's below-target-movable signal.
3. **Persist the Gen 29 critical-audit findings** to `.evolve/critical-audit/2026-04-18T...-gen29/` retroactively. Establishes the pattern for future pursue diffs.
4. **Ship scripts/provider-compat-smoke.mjs.** Catches Gen 30 R2-style plumbing bugs before real runs burn time.
5. **Merge PR #64** (Gen 29 + 30 R1 + R2). Everything green, audit closed, non-regression proven on local-smoke. Blocked only on WebVoyager 590 validation — which once run, flips the merge gate.
6. **Split `src/brain/index.ts`.** 2700 lines is past the readability ceiling. Extract prompts, decideVision, provider setup. This showed up in the Gen 13-26 reflection too — debt keeps accumulating.
7. **Capture the "competitor-audit → union-framing" decision** via `/capture-decisions`. It was the highest-leverage moment of Gen 29 and should be retrievable in future sessions.

## Dispatch

**Next: `/evolve` targeting WebVoyager 590 pass rate** — use Tangle router + claude-sonnet-4-6 as the primary (newly-validated cheaper) model, compare against Gen 25 baseline of 539/590 (91.3%). Same-day baseline can come from running Gen 29 branch + Gen 30 R1/R2 changes as the treatment. Expected outcome: measurable pass-rate delta across Gen 26-30 (stealth bypass helped ~9 blocked sites; per-role cascade helped cost; macros unlikely to fire on WebVoyager but shouldn't regress).

Rationale: this is the single action that unblocks the most downstream decisions. Governor's next call will have a current scorecard to reason from; the PR can ship with a verified number; and the "measurement-rigor arc" lands with its own data.

If WebVoyager quota or setup friction blocks (same pattern as Gen 30 R1), fall back to `/governor` and re-dispatch to: (a) scripts/update-scorecard.mjs quick infra ship, (b) provider-compat-smoke ship, then try WebVoyager again. Don't loop on the same blocked run.
