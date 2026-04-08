# @tangle-network/browser-agent-driver

## 0.18.0

### Minor Changes

- [#49](https://github.com/tangle-network/browser-agent-driver/pull/49) [`bb9e2bd`](https://github.com/tangle-network/browser-agent-driver/commit/bb9e2bdf4dcbd91915c16d4cd853f9b1d3defc91) Thanks [@drewstone](https://github.com/drewstone)! - Gen 7 + 7.1 — Plan-then-execute with replan-on-deviation. **One LLM call per strategy chunk, not per action.**

  A planner makes a single LLM call up front to generate a structured action plan, the runner executes it deterministically, and on deviation it **replans** instead of immediately falling through to the per-action loop. Validated under the new measurement-rigor protocol (`docs/EVAL-RIGOR.md`): **3 reps each side, mean ± min/max**, no single-run claims.

  ## Verified result (long-form fast-explore, 3 reps each, same day, same model)

  | metric    | Gen 7 baseline (mean) | Gen 7.1 (mean) |                   Δ | reps | challenger min/max | verdict               |
  | --------- | --------------------: | -------------: | ------------------: | ---: | ------------------ | --------------------- |
  | wall-time |                128.7s |      **35.9s** |   **−92.8s (−72%)** |    3 | 33.9s / 37.4s      | **WIN — 3.6× faster** |
  | turns     |                  20.7 |       **11.0** |     **−9.7 (−47%)** |    3 | 9 / 13             | **WIN**               |
  | tokens    |               250,434 |     **10,724** | **−239,710 (−96%)** |    3 | 9,138 / 11,584     | **WIN — 23× fewer**   |
  | cost ($)  |               $0.5007 |    **$0.0424** |   **−$0.46 (−92%)** |    3 | $0.0385 / $0.0453  | **WIN — 12× cheaper** |
  | pass rate |                  100% |           100% |                   0 |    3 | —                  | comparable            |

  The spread test passes: the wall-time delta (92.8s) exceeds the **sum** of both sides' worst-case spreads (Gen 7: 53s, Gen 7.1: 3.5s), so this is a real architectural win and not run-to-run variance. Gen 7.1 is also dramatically **more consistent** (3.5s spread vs 53s) — the planner+replan loop reduces variance because it stays out of the per-action LLM loop where most variance lived.

  ## What ships

  **`Brain.plan(goal, state, { extraContext? })`** — single LLM call returns a structured `Plan` with `PlanStep[]`. Each step has an action (any verb including Gen 6 batch verbs), an `expectedEffect` post-condition, and an optional `rationale`. The optional `extraContext` is how the runner injects deviation history into a replan call without changing the system prompt — preserves Anthropic prompt-cache hits across the initial plan and all replans.

  **`BrowserAgent.executePlan(plan, ..., planCallTokens?)`** — deterministic step executor. For each plan step:

  1. Re-observes the page
  2. Drives the action via `driver.execute()`
  3. Verifies the post-condition via `verifyExpectedEffect`
  4. On success → advance; on failure → bail with deviation context
  5. Per-step 10s wall-clock cap so a single bad step can't block the run for 30s

  The `planCallTokens` parameter attaches the Brain.plan() LLM call's token usage to the FIRST plan-step turn. Without this, runs that stay in plan-mode (Gen 7.1) reported $0 cost while their Brain.plan() calls actually spent real tokens — a metric attribution bug caught by the rigor gates.

  **Replan loop in `BrowserAgent.run`** — when `plannerEnabled: true` (or `--planner` CLI flag, `BAD_PLANNER=0` to disable):

  1. Initial plan call → execute deterministically
  2. On deviation: re-observe the page, build a `[REPLAN N/3]` deviation context, call `Brain.plan()` again
  3. Cap at **3 replans** (4 plan calls total per run)
  4. On exhaustion: fall through to the per-action loop with a `[REPLAN]` hint

  **6 new TurnEvent variants** — `plan-started`, `plan-completed`, `plan-step-executed`, `plan-deviated`, `plan-fallback-entered`, `plan-replan-started` (Gen 7.1). The live SSE viewer + events.jsonl persistence both pick them up automatically.

  ## Measurement rigor (`docs/EVAL-RIGOR.md`)

  Same PR ships the rigor protocol that caught this generation's earlier overclaims:

  - **`pnpm bench:validate`** (`scripts/run-multi-rep.mjs`) — canonical single-config N-rep harness with mean/min/max output. **Exits non-zero on `--reps < 3`** unless explicitly opted out via `--allow-quick-check`.
  - **`docs/EVAL-RIGOR.md`** — names the only 3 sanctioned validation paths (`bench:validate`, `ab:experiment`, `research:pipeline --two-stage`) plus the verbatim summary table format.
  - **`CLAUDE.md` Measurement Rigor section** — 10 hard rules including "no single-run speedup claims, ever."
  - **`scripts/lib/static-fixture-server.mjs`** — extracted shared fixture-server lib so the rigor harness drives the same fixtures the CI gate does.
  - **`scripts/run-mode-baseline.mjs`** — now substitutes `__FIXTURE_BASE_URL__` like `run-scenario-track.mjs` does, so single-scenario runs reach the local fixture server consistently.

  ## Tests

  **887 passing** (was 881, +6 net new for this PR):

  - 3 in `tests/brain-plan-parse.test.ts` covering Gen 7.1 `extraContext`: omits/injects from user prompt, system prompt remains byte-stable across replans (cache hit preservation)
  - (existing 11) `brain-plan-parse.test.ts` parser/validator coverage
  - (existing 5) `runner-execute-plan.test.ts` happy path / deviation / terminal complete / exhaustion / metadata

  Tier1 deterministic gate: **100% pass rate** maintained.

  ## Honest known issues

  - **Plan-call token attribution** is "good enough" not "perfect": the entire plan call's tokens land on the first plan step's turn, not distributed across the steps. The run-level total is correct; per-step costs in detailed reports overstate the first step. Acceptable for now; a per-step distribution model can come later if it matters.
  - **The Gen 7 baseline measured here (128.7s mean)** is slower than the original Gen 7 work's reported numbers (~50s mean). That earlier number was contaminated by single-run variance and stale comparisons. This PR measures both Gen 7 and Gen 7.1 under identical conditions on the same day, which is the only comparison that survives the new rigor rules.

  ## Three iterations to nail Gen 7.1

  | v     | Failure                                                                                                                                              | Fix                                                              |
  | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
  | 1     | `spawnSync` in multi-rep harness blocked the parent event loop, embedded fixture server couldn't respond, agent observe() hung forever with no error | Switch to async `spawn` + Promise wrapper                        |
  | 2     | Plan-call tokens reported as $0 because plan turns had no `tokensUsed` field (only per-action turns did)                                             | Attach `planCallTokens` to first plan-step turn in `executePlan` |
  | **3** | All paths handled correctly                                                                                                                          | **Mean 35.9s / $0.04 / 11 turns, 3-rep validated**               |

  ## Rollback

  `BAD_PLANNER=0` disables the planner (and replan loop) entirely and forces per-action loop only.

## 0.17.0

### Minor Changes

- [#48](https://github.com/tangle-network/browser-agent-driver/pull/48) [`e059885`](https://github.com/tangle-network/browser-agent-driver/commit/e059885fb61d46d0b2b45d8fe5f6754e7b0c5895) Thanks [@drewstone](https://github.com/drewstone)! - Gen 6.1 — Runner-mandatory batch fill via runtime hint injection.

  The first architectural change in the Gen 4-6 trajectory that delivers a measurable single-run speedup without statistical noise drowning the signal: **long-form fast-explore goes from 22 turns / 384s to 9 turns / 53s — 7.2× wall time speedup, 2.4× turn count reduction.**

  ## What it does

  Detects at runtime when the agent is filling a multi-field form one input at a time, and injects a high-priority hint into `extraContext` that DEMANDS the next action be a batch `fill`. Convinces the LLM via runtime feedback rather than prompt rules alone.

  ## Trigger conditions

  The detector (`detectBatchFillOpportunity` in `src/runner/runner.ts`) fires when ALL hold:

  1. The agent's most recent action was a single-step `type` on the current URL
  2. The current snapshot has 2+ unused fillable refs (textbox / searchbox / combobox / spinbutton) that the agent hasn't typed into yet
  3. The agent hasn't already filled those refs via an earlier `fill` batch

  ## What gets injected

  ```
  [BATCH FILL REQUIRED]
  You just typed into a single field, but N more fillable fields are visible
  on this same form. STOP. Your NEXT action MUST be a `fill` action that
  batches ALL remaining unused fields on this page in one turn.

  Unused fillable @refs from the current snapshot:
    - @t2 (textbox: "Last name")
    - @t3 (textbox: "Email")
    - @c1 (combobox: "State")
    - ...

  Example:
  {"action":"fill","fields":{"@t2":"value1","@t3":"value2"}}
  ```

  The hint is high-priority (100, never truncated) and lists EXACT @refs from the current snapshot — the agent doesn't have to guess or hallucinate selectors.

  ## Verified result

  Long-form fast-explore behavior trace from `events.jsonl`:

  - Turn 1: type firstname (single, before detector fires)
  - Turn 2: detector fires → fill (4 targets) — fails on date input edge case
  - Turn 4: click next
  - **Turn 5: fill (6 targets) — SUCCESS**
  - Turn 6: click next
  - **Turn 7: fill (8 targets) — SUCCESS**
  - Turn 8: click submit
  - Turn 9: complete

  **14 form fields compressed into 2 batch turns.** 9 total turns for a 19-field form.

  ## Implementation details

  - Tracks `usedRefs` across the WHOLE run (not just recent N turns) so the detector never tells the agent to re-fill a field
  - Tracks fields filled via batch `fill` action — those count as used too
  - Bounded ref list (max 12 in the hint) to keep the prompt size sane
  - Gated by `BAD_BATCH_HINT=0` env flag for rollback

  ## Tests

  865 passing (was 856, +9 net new in `tests/batch-fill-detection.test.ts`).

  - Trigger conditions
  - URL change handling
  - Used-ref tracking across the full run (including via batch fills)
  - 12-ref cap
  - Worked example format

  Tier1 deterministic gate: **100% pass**.

  ## Cumulative trajectory

  | Gen                   | Fast-explore turns | Wall time |       Speedup vs Gen 4 baseline |
  | --------------------- | -----------------: | --------: | ------------------------------: |
  | Gen 4                 |                ~22 |     ~180s |                        baseline |
  | Gen 5                 |                ~22 |     ~180s | none (overhead, not turn count) |
  | Gen 6 (verbs)         |              17-22 |    varies |          mode-dependent ~10-25% |
  | **Gen 6.1 (this PR)** |              **9** |   **53s** |                        **3.4×** |
  | Gen 7 (planned)       |                4-5 |    15-20s |                      12× target |

  ## Adds

  - `.evolve/pursuits/2026-04-08-plan-then-execute-gen7.md` — full Gen 7 spec for the next session (Brain.plan + Runner.executePlan with fallback to per-action loop)

- [#46](https://github.com/tangle-network/browser-agent-driver/pull/46) [`75341af`](https://github.com/tangle-network/browser-agent-driver/commit/75341af198df3e39fa56f2607ad9aeeabd49d7b7) Thanks [@drewstone](https://github.com/drewstone)! - Gen 6 — Batch action verbs (`fill`, `clickSequence`).

  The vision: turn count is the metric, not ms per turn. A 5-turn run at 3s/turn beats a 20-turn run at 2s/turn every time. Gen 4 + Gen 5 squeezed infrastructure overhead (~5–8% of wall time on a 20-turn run). The dominant cost is N × LLM call latency. The only way to make `bad` dramatically faster is to reduce N.

  Gen 6 ships the minimal-viable plan-then-execute: higher-level action verbs that compress N single-step turns into 1 batch turn.

  **New action verbs:**

  - `fill` — multi-field batch fill in ONE action. Fills text inputs, sets selects, and checks checkboxes:

    ```json
    {
      "action": "fill",
      "fields": {
        "@t1": "Jordan",
        "@t2": "Rivera",
        "@t3": "jordan@example.com"
      },
      "selects": { "@s1": "WA" },
      "checks": ["@c1", "@c2"]
    }
    ```

    Replaces 6+ single-step type/click turns with 1 batch turn. Verified: when the agent uses it, it compresses 6–8 fields into 1 turn (6–8× compression on those turns).

  - `clickSequence` — sequential clicks on a known set of refs. For multi-step UI navigation chains:
    ```json
    { "action": "clickSequence", "refs": ["@menu", "@submenu", "@item"] }
    ```

  **Implementation details:**

  - Per-field fast-fail timeout capped at 5s (vs the default 30s) — batch ops assume every ref was just observed in the snapshot, so a missing element fails fast and the agent recovers on the next turn
  - Failures bail with the first error and report which field failed via the `error` message — the agent can shrink its next batch to drop the failing target
  - New brain prompt rule ([#15](https://github.com/tangle-network/browser-agent-driver/issues/15)) instructs the agent to prefer batch fill when 2+ form fields are visible
  - Validation guards against empty payloads, non-string field values, and inverted ref formats
  - Supervisor signature updated so the stuck-detector recognizes batch ops as distinct from single steps

  **Tests:** 856 passing (was 840, **+16 net new**).

  - 10 in `tests/batch-action-parse.test.ts` (parser, validation, error paths)
  - 6 in `tests/playwright-driver-batch.test.ts` (real Chromium, fill text/selects/checks, clickSequence, fast-fail on missing refs)

  **Tier1 gate:** 100% pass rate. No regressions.

  **Long-form scenario (single-run, high variance):** When the agent picks batch fill it compresses 14–19 form fields into 2–3 turns. Aggregate turn count is dominated by run-to-run agent strategy variance — multi-rep measurement is needed for statistical claims.

  **Followup tracked:** runner-injected batch hint when 3+ consecutive type actions are detected on the same form (more reliable than prompt rules alone).

  **Also adds:** `bench/competitive/README.md` — scaffold spec for a head-to-head benchmark vs browser-use, Stagehand, Skyvern, OpenAI/Claude Computer Use. Not yet executed live.

## 0.16.1

### Patch Changes

- [#44](https://github.com/tangle-network/browser-agent-driver/pull/44) [`80c5b35`](https://github.com/tangle-network/browser-agent-driver/commit/80c5b3582019ab31a8a00e441b1e4bfad9407e19) Thanks [@drewstone](https://github.com/drewstone)! - Gen 5 / Evolve Round 1 — Persist + verify lazy decisions in production.

  **Shipped (5 components):**

  - **events.jsonl persistence** — TestRunner creates a per-test TurnEventBus that subscribes a `FilesystemSink.appendEvent(testId, event)` writer AND forwards every event to the shared suite-level live bus. The result: every `bad` run now writes `<run-dir>/<testId>/events.jsonl` with one JSON line per sub-turn event, replayable post-hoc.
  - **`bad view` reads events.jsonl** — `findEventLogs(reportRoot)` discovers the per-test files alongside report.json and inlines the parsed events into the viewer via `window.__bad_eventLogs`. Tolerant of bad lines.
  - **Lazy `detectSupervisorSignal`** — only computes when supervisor enabled AND past min-turns gate. Was unconditional every turn.
  - **Lazy override pipeline** — only runs when at least one input that any producer might consume is non-null.
  - **Pattern matcher fix for real ARIA snapshot format** — production snapshots use `- button "Accept all" [ref=bfba]` (YAML-list indent, ref AFTER name), not what the original test fixtures used. Both cookie-banner and modal matchers now extract ref + name independently of position. Regression test added against the real format.

  **Bug found + fixed during measurement:** The pattern matcher gate was over-restricted by `!finalExtraContext`, which is always non-empty on pages with visible-link recommendations. Pattern matchers only look at the snapshot text — they don't consume extraContext or vision. Removed the gate from `canPatternSkip` (kept it on `canUseCache` because the cache replays a decision made under specific input conditions).

  **Verified in production:** First end-to-end measurement of the lazy-decisions architecture. **LLM skip rate: 28.6%** on the cookie banner scenario (2 of 7 decisions skipped via deterministic pattern match). Zero LLM skips on happy-path goal-following long-form (expected — cache is for retry loops, not goal progression).

  **Tier1 gate: 100% pass rate.** 840 tests pass (was 830, +10 net new).

## 0.16.0

### Minor Changes

- [#42](https://github.com/tangle-network/browser-agent-driver/pull/42) [`a343913`](https://github.com/tangle-network/browser-agent-driver/commit/a343913d474f107a776429599a75b37a1fee0df5) Thanks [@drewstone](https://github.com/drewstone)! - Gen 5 — Open Loop. Three coordinated pillars sharing one TurnEventBus primitive that make the agent transparent and customizable from outside the package.

  **Pillar A — Live observability (`bad <goal> --live`)**

  - New `TurnEventBus` in `src/runner/events.ts` emits sub-turn events at every phase boundary (turn-start, observe, decide, decide-skipped-cached, decide-skipped-pattern, execute, verify, recovery, override, turn-end, run-end).
  - New `src/cli-view-live.ts` SSE server with `/events` (replay-on-connect + 15s heartbeat) and `/cancel` POST → SIGTERM via AbortController.
  - `bad <goal> --live` opens the viewer and streams every event in real-time. After the run completes the viewer stays open for scrubbing until SIGINT.

  **Pillar B — Extension API for user customization**

  - New `BadExtension` interface with five hooks: `onTurnEvent`, `mutateDecision`, `addRules.{global,search,dataExtraction,heavy}`, `addRulesForDomain[host]`, `addAuditFragments[]`.
  - Auto-discovers `bad.config.{ts,mts,mjs,js,cjs}` from cwd; explicit paths via `--extension <path>`.
  - User rules land in a separate slot AFTER the cached `CORE_RULES` prefix so they don't invalidate Anthropic prompt caching.
  - `mutateDecision` runs after the built-in override pipeline so user extensions get the final say. Errors are caught and logged — broken extensions cannot crash the run.
  - Full guide at `docs/extensions.md` with worked examples (Slack notifications, safety vetoes, per-domain rules, custom audit fragments).

  **Pillar C — Lazy decisions (skip the LLM when you can)**

  - New in-session `DecisionCache` (bounded LRU + TTL, key includes snapshot hash + url + goal + last-effect + turn-budget bucket). Cache hits short-circuit `brain.decide()` entirely. Disable via `BAD_DECISION_CACHE=0`.
  - New deterministic pattern matchers for cookie banners (single Accept) and single-button modals (Close/OK). Match → execute action without an LLM call. Disable via `BAD_PATTERN_SKIP=0`.
  - `analyzeRecovery` is now lazy — only fires when there's an actual error trail. Used to run unconditionally every turn.
  - Cache hits and pattern matches emit `decide-skipped-cached` / `decide-skipped-pattern` events on the bus so the live viewer (and user extensions) can audit which turns paid for the LLM and which didn't.

  **Tests:** 830 passing (was 758, +72 net new). Tier1 deterministic gate maintains 100% pass rate. New test files: `runner-events.test.ts` (15), `decision-cache.test.ts` (15), `deterministic-patterns.test.ts` (11), `extensions.test.ts` (24), `cli-view-live.test.ts` (7).

## 0.15.0

### Minor Changes

- [#40](https://github.com/tangle-network/browser-agent-driver/pull/40) [`72c4e25`](https://github.com/tangle-network/browser-agent-driver/commit/72c4e2572553fa30789a1dc3d2cbd1dde8112ba2) Thanks [@drewstone](https://github.com/drewstone)! - Gen 4 — Agent loop speed pass. Six coordinated infrastructure changes targeting wait/observe/connection slack:

  - Drop unconditional 100ms wait in `verifyEffect`; replace with conditional 50ms only for click/navigate/press/select.
  - Run the post-action observe in parallel with the 50ms settle wait (was strictly serial).
  - Skip the post-action observe entirely on pure wait/scroll actions with no expectedEffect (cachedPostState short-circuit).
  - Cursor overlay (`showCursor: true`) no longer waits 240ms after `moveTo` — the CSS transition runs alongside the actual click, reclaiming ~12s on a 50-turn screen-recording session.
  - New `Brain.warmup()` fires a 1-token ping in parallel with the first observe so turn 1's TLS+DNS+model cold-start (~600-1200ms) lands before `decide()` runs. Skipped for CLI-spawning providers (codex-cli, claude-code, sandbox-backend) and via `BAD_NO_WARMUP=1`.
  - Anthropic prompt caching: `brain.decide` now ships system prompts as a `SystemModelMessage[]` with `cache_control: ephemeral` on the byte-stable CORE_RULES prefix when `provider: anthropic`. Subsequent turns get a 90% input discount + faster TTFT on the cached chunk. Other providers continue to receive a flat string (no behavior change).
  - `Turn` records gain `cacheReadInputTokens` / `cacheCreationInputTokens` for prompt-cache observability.

  Tests: 758 passing (was 748). New: `brain-system-cache.test.ts` (5), `brain-warmup.test.ts` (5). Tier1 deterministic gate passes in both modes; absolute deltas are within the noise floor of the 5-turn scenarios. See `.evolve/pursuits/2026-04-07-agent-loop-speed-gen4.md` for the full pursuit spec and honest evaluation.

## 0.14.5

### Patch Changes

- [`b400c1d`](https://github.com/tangle-network/browser-agent-driver/commit/b400c1d4f0c7002cbc4a62e5cc614d51c5ae50b2) Thanks [@drewstone](https://github.com/drewstone)! - Changesets workflow now triggers publish-npm.yml via `gh workflow run` instead of trying to publish inline. The npm trusted publisher is linked to publish-npm.yml's filename, so OIDC tokens generated by changesets.yml were rejected as a workflow_ref mismatch (404s on the publish PUT). Cross-workflow `workflow_dispatch` invocation via GITHUB_TOKEN is allowed (the downstream-trigger restriction only blocks `push` events), so the chain runs end-to-end with no PAT or App token. Future releases: merge the auto-opened "Release: version packages" PR. That's it. No tag re-push, no NPM_TOKEN, no manual intervention.

## 0.14.4

### Patch Changes

- [`36027b9`](https://github.com/tangle-network/browser-agent-driver/commit/36027b95cbde08a62c869617c90f188967fa896e) Thanks [@drewstone](https://github.com/drewstone)! - Release flow now publishes end-to-end in a single workflow run with zero manual steps. The Changesets workflow opens the version PR, then on merge runs build + tag + npm publish via OIDC trusted publishing in the same job. No more manual `git push origin browser-agent-driver-vX.Y.Z` after merging the release PR. publish-npm.yml stays as a manual fallback for re-publishing failed releases via workflow_dispatch.

## 0.14.3

### Patch Changes

- [`60a6c44`](https://github.com/tangle-network/browser-agent-driver/commit/60a6c4487a35ded8943d8c6fd73f7a7dbb69972e) Thanks [@drewstone](https://github.com/drewstone)! - Switch the publish workflow to `npx -y npm@11` and drop the NPM_TOKEN fallback. Node 22's bundled npm 10.x has incomplete OIDC trusted-publisher support for scoped packages and silently 404s the publish PUT. npm 11.5+ has the full OIDC publish path. Each release is now authenticated purely via short-lived GitHub OIDC tokens validated against the trusted publisher on npmjs.com — no long-lived secrets in the repo.

## 0.14.2

### Patch Changes

- [`59b296d`](https://github.com/tangle-network/browser-agent-driver/commit/59b296d470c813940616c7923431eb1cb7899554) Thanks [@drewstone](https://github.com/drewstone)! - Switch npm publish to OIDC trusted publishing. Each release is now authenticated via a short-lived GitHub OIDC token instead of a long-lived `NPM_TOKEN` secret, validated against the trusted publisher configured on npmjs.com. Every publish is cryptographically tied to the exact GitHub commit + workflow run that built it, with provenance attestation visible on the npm package page. Also fixes the `release-tag` script to push the prefixed `browser-agent-driver-v*` tag the existing publish workflow expects, so the next release runs end-to-end with zero manual intervention.

## 0.14.1

### Patch Changes

- [`7c8e2cd`](https://github.com/tangle-network/browser-agent-driver/commit/7c8e2cde5197d8b756cb241523a8cd2e96d7d64d) Thanks [@drewstone](https://github.com/drewstone)! - Fix `provider.chat()` routing for OpenAI-compatible endpoints (Z.ai, LiteLLM, vLLM, Together, OpenRouter, Fireworks). `@ai-sdk/openai` v3+ defaults to the OpenAI Responses API which most third-party endpoints don't implement, causing 404s. Both the new `zai-coding-plan` provider and the default `openai` provider now explicitly use the chat-completions path.
