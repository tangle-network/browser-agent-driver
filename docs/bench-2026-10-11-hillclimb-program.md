# The hillclimb program: six waves on the `bad` driver (2026-10-10 → 2026-10-11)

**Close-out artifact.** One day, six waves, one identical bench corpus (3 fixture + 2 real-web tasks × 3 reps, gemini-2.5-flash, headless, external oracle, same machine). Everything below is backed by retained per-run artifacts under `agent-results/` (gitignored) and the per-wave delta docs (`docs/bench-2026-10-11-*.md`).

## The arc (headline table)

| stage | PR | bad pass | cost/run | wall/run | cache rate | browser-use (same window) |
|---|---|---|---|---|---|---|
| Baseline (post parser fix) | #154 | 12/15 | $0.0503 | 49.2s | 16% | 10/15 · $0.0120 |
| Wave 1 — first fixes + 2 reverts | #156 | 13/15 | $0.0591 | 66.1s | ~16% | 13/15 · $0.0128 |
| Wave 2 — prefix history, verifier, selector guard | #157 | 15/15 | $0.0470 | 51.1s | 23% | 13/15 · $0.0125 |
| Wave 3 — explicit cache, serializer, date root-fix | #158 | 15/15 | $0.0370 | 21.1s | 18% | 12/15 · $0.0128 |
| Wave 4 — token-aware tail, replay spike | #159 | 15/15 | $0.0221 | 17.7s | 28% | 11/15 · $0.0150 |
| Wave 5 — budget, corroboration, replay productized | #160 | 12/15 (weather) · **10/10 var arm** | $0.0263 | 26.2s | 30% | 12/15 · $0.0140 |
| **Wave 6 — surrender guard, form-echo, close-out** | this PR | **15/15** · **10/10 var arm** | **$0.0223** | **17.9s** | **30%** | 12/15 · $0.0126 |

**Program totals: pass 12/15 → 15/15 (held five corpora including two n=5 variance arms at 10/10), cost $0.0503 → $0.0223 (−56%), wall 49.2s → 17.9s (−64%), cost ratio vs browser-use 4.2× → 1.8× (peak 1.47× at wave 4).** Spend for the entire program: ~$11 on Gemini (zero OpenAI per policy).

## Technique → delta attribution

| technique (wave) | measured effect |
|---|---|
| **#154 complete-result parser fix** (pre-program) | bad 5/15 → 12/15. The single biggest unlock: Gemini emits structured `complete.result` as an object; the parser string-typed it to `""`. One-line-class fix found *by* the harness. |
| Output-truncation hygiene (w1: cap raises, action-first schema, 4096 caps at decide+verifier) | Killed the truncated-JSON retry class. Wave-3 hn rep2 (3 malformed turns at out=3992) → wave-6 hn at 2–3 clean turns. |
| Reverted-on-evidence (w1: thinkingBudget 0, zero-diff suppression) | Both dropped after isolation: thinking-0 caused strategy loops (11/15), zero-diff made the model conclude "page broken" (form-fill 0/3). The bench's job is to kill plausible-sounding ideas cheaply. |
| Prefix-stable + token-aware history (w2, w4) | Cache rate 16%→23%→28%; **mean input −49% at wave 4** (the 8-message tail was blind to message size). |
| Verifier program (w2: instrumentation + slimming + field corroboration; w5–6: goal-literal corroboration incl. apostrophe/form-echo fixes) | Verifier tokens now visible in run metrics; **wave-6: 11/15 completions corroborated zero-LLM, 3 llm, 1 fast-path** (wave-4 was 8 llm). The over-conservatism and under-coverage bugs were both artifact-driven finds. |
| Fail-closed guards (w2 selector guard, w3 combinator tightening, w5 extraction-stall, w6 surrender guard) | The blind-selector loop class went from ~all failure mass to zero occurrences across five corpora. Surrender guard: wave-5's confabulated turn-1 abort is now rejected by construction (runner-boundary regression test). |
| Serializer port + date-control root fix (w3) | form-fill cost −54%, wall −87%; the CDP-vs-YAML pipeline gap was found by an isolation run, not by reading code. |
| Explicit cachedContent + system-prompt freeze (w3) | Flat per-turn cached reads; killed the mid-run system-prompt flip that split cache entries. |
| Verified-step replay (w4 spike, w5 productized) | **CI-rerun economics: a replayed task costs one verification call ($0.001–0.004, sometimes zero with corroboration) and ~8s wall, vs ~$0.02+ and ~20s live — with fail-closed self-heal to the live agent as the worst case.** |

## The parity verdict (accepted as program ceiling)

**~1.3–1.6× browser-use cost is the asymptote; 1.0× is the wrong target.** bad's per-decide floor (cached system ~3.5k + 12k-char windowed snapshot ~3.5k + 20k-char history tail ~5k + thinking-token output ~1–2k) is now in browser-use's per-turn range (~16k). The residual gap is (a) extraction-task turn counts (2–7 vs browser-use's 2) and (b) thinking-token billing — and every experiment that cut thinking (wave 1's thinkingBudget 0, wave 4's 512 A/B) traded pass rate for it. Chasing 1.0× further would compromise the two things measurably better here: **extraction accuracy** (dashboard-extract: bad 5/5 vs browser-use 3/5 at n=5, twice) and the **verified-replay moat** (browser-use has no zero-model-call verified replay). The program's verdict: buy the remaining gap only where it doesn't touch those — corroboration coverage, surrender guards, replay adoption in CI.

## What replay means for CI economics

A CI suite that re-runs N browser tasks per PR pays ~N × $0.02 + ~20s wall per task live. With verified replay: the first green run persists the trajectory (goal digest + origin + route-normalized `:id` path + TTL); subsequent runs on the same route replay with **zero decide calls** and at most one verification call — ~10–20% of the LLM cost and ~30–40% of the wall. Fail-closed relocation (guard checks action-performability against a fresh observation; any mismatch heals to the live agent, costing a few fast browser actions) means a stale replay is never worse than running live. Staleness is measurable per run via `AgentResult.replay` (attempted/outcome/steps/llmCallsUsed in report.json). CI convention: archive `BAD_MEMORY_DIR` (default `.agent-memory`) as a build artifact.

## The standing bench procedure (adoption pipeline for future engines/models)

When a new harness or model needs evaluation, run the program's own procedure:

1. **Corpus:** `bench/competitive/tasks/` — 3 fixture + 2 real-web, ≥3 reps (repo rigor minimum; use 5 for variance-heavy cells), external oracle per task. Add tasks by dropping a JSON with `id/goal/startUrl/maxTurns/oracle`.
2. **Same-day, same-machine, same-key control:** never compare against numbers from another day — provider weather moves cells by 2–3 points (proven repeatedly: the wave-5 dx 0/3 window, browser-use's own 10→13/15 drift).
3. **Command:** `pnpm bench:compete -- --frameworks bad,browser-use --tasks … --reps 3 --model <m> --baseline bad --out agent-results/competitive-<label>`. Keys via `dotenvx run -f devops/secrets/tangle-router.env -- …` with `OPENAI_API_KEY` unset for Gemini arms (`GOOGLE_AI_KEY` mapped to `GEMINI_API_KEY`; the file's `GEMINI_API_KEY` is stale) or a fresh provider key. **HEADLESS ALWAYS** — the adapters enforce it; do not weaken it.
4. **Isolation rule:** any pass-rate regression gets an isolation rerun on the affected cells before a change is dropped or kept. Weather vs structure is decided by reruns, not vibes.
5. **Stats:** Wilson 95% CIs per cell (the runner computes them); n=3 is the operational minimum, n=5 for cells with a variance history; quick-check runs (`--allow-quick-check`) prove plumbing only and are never cited.
6. **Cost conventions:** per-token rates come from LiteLLM's price table for both adapters (bad's `src/model-pricing.ts` and the competitive adapters share the source); loopback/local endpoints report $0.
7. **Adopt an engine only on numbers:** if a challenger beats `bad` on pass rate under this procedure with equal or better cost, its adapter graduates from `bench/competitive/adapters/` to a first-class integration — that's the pivot RFC's adoption pipeline (docs/rfc/driver-pluggable-pivot-2026-10.md).

## What was deliberately NOT done

- No new agent-loop features (the bespoke loop stays frozen per the pivot RFC — everything shipped is parser/serializer/verifier/guard/replay work around it).
- No 1.0× cost-parity chase (see verdict).
- Replay stays minimal: no UI, no cache-management commands, no cross-origin matching.
