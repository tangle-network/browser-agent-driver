# Pursuit: Gen 9 retrospective + Gen 10 proposal
Generation: 9 (closed) / 10 (proposing)
Date: 2026-04-08
Status: Gen 9 closed without merge — Gen 10 awaiting user approval
PR closed: tangle-network/browser-agent-driver#59

## What Gen 9 was

A surgical change to `executePlan`: when the planner-emitted runScript step returned null / empty / `{x: null}` / placeholder pattern, the runner declined to auto-complete with that garbage and fell through to the per-action loop with a `[REPLAN]` context naming the failure. The per-action loop's `Brain.decide` then got a fresh observation of the loaded page and a chance to emit a smarter action.

The thesis was: "browser-use wins on npm/mdn/w3c because it iterates after a failed extraction. Give bad's per-action loop the same recovery surface and it should match."

## What actually happened

**Pass rate did not move at n=3:**

| metric | Gen 8 head-to-head | Gen 9 (3 reps) | Gen 9.1 (3 reps) |
|---|---:|---:|---:|
| pass rate | 23/30 = 77% | 21/30 = 70% | 23/30 = 77% |
| mean wall-time | 9.2s | 13.5s | ~13s |
| mean cost | $0.0168 | $0.0256 | ~$0.025 |

Gen 9.1 added an explicit recovery prompt + the failed-script-in-deviation-reason. It moved per-task scores around (+1 here, -1 there) but the net was zero.

**5-rep validation revealed a real cost regression:**

| task | Gen 8 (3 reps) | Gen 9.1 (5 reps in-flight) | what happened |
|---|---:|---:|---|
| reddit-subreddit-titles | 3/3 @ ~$0.015/run | **3/5** with rep 3 = **$0.25 / 132K tokens** and rep 4 = **$0.32 / 173K tokens** | death-spiral recovery loop |
| mdn-array-flatmap | 2/3 | **0/5** | recovery REGRESSED — more chances to fail with the same wrong selector |
| npm-package-downloads | 1/3 | **3/5** | partial win |

I killed the 5-rep run mid-flight after seeing reddit hit $0.32 on a single task that previously cost $0.015. **A non-improvement that introduces 20× cost regressions on previously-passing tasks is a regression, not a "mechanism PR."**

## Root cause

Three failure modes compound:

1. **Same LLM, same wrong answer.** Iterating with the same `gpt-5.4` that picked the wrong selector the first time produces the same wrong selector the second time. The `[REPLAN]` context tells the LLM "your previous selector returned null" but doesn't change *what selectors are visible to the LLM* — and the limiting factor was the visible selector set, not the LLM's reasoning.

2. **Unbounded recovery cost.** The per-action loop has no token budget cap on the recovery path. When a selector fails and the LLM keeps emitting variations of the same wrong query, the loop burns turns until it hits the case timeout. On reddit this manifested as 132K → 173K tokens per run vs the normal ~6K.

3. **Mechanism vs intelligence.** Gen 9 proved the *mechanism* works (the fall-through fires correctly, the deviation reason is built correctly, the per-action loop receives the context). But mechanism alone is worthless if the recovery action isn't actually different from the failing action.

## What we keep from Gen 9

- **`isMeaningfulRunScriptOutput()` helper** — the primitive is real and has 11 unit tests. It detects null/empty/literal-`"null"`/`{}`/`[]`/all-null-objects/partial-null-objects/placeholder-pattern. Worth keeping for future code: validators, cost gates, attribution metrics.
- **The 12 unit tests** in `tests/runner-execute-plan.test.ts` that proved the helper works.
- **The honest data**: we now know LLM-iteration recovery doesn't work, which means we can stop trying it and move to approaches that actually fix the underlying problem.

## What we throw away from Gen 9

- The `executePlan` Gen 9 fall-through branch (auto-complete decline → return deviated)
- The `[REPLAN — runScript extraction failed]` context build-up in `BrowserAgent.run`
- The `gen9-runtime-two-pass-extraction` branch (closed, not merged)
- PR #59 (closed)

---

## Gen 10 proposal

### The actual lesson from Gens 8 + 9

The bottleneck on the failing tasks is **not "the LLM didn't get a second try"** — it's **"the LLM never had visibility into the right element"**. browser-use wins on npm/mdn/w3c because its DOM serialization gives the LLM a numbered list of *every interactive element with its full text content*, and the LLM picks elements by index. Our planner emits raw DOM queries based on the ARIA snapshot, which compresses away the data the LLM needs.

Two of the failing tasks make this concrete:

- **mdn-array-flatmap**: the signature `flatMap(callbackFn)` is in a `<dl>` definition list that ARIA snapshot collapses to "term" / "definition" without the function name. The LLM has no way to write a selector that finds it because the snapshot doesn't show the text.
- **npm-package-downloads**: the weekly download count is in a `<p>` deep in a sidebar that loads via XHR after first render. The ARIA snapshot at observation time doesn't include the text yet, so the LLM writes `document.querySelector('.weekly')` which doesn't exist.

In both cases, **iterating doesn't help** because no number of retries with the same observation gives the LLM visibility into the missing data. The fix has to be at the observation layer, not the recovery layer.

### Gen 10 thesis

**Replace placeholder iteration with one architectural change: extract a numbered, text-rich element index from the live DOM at extraction time, and let the LLM reference elements by index instead of by selector.**

This is the browser-use approach and it's the only thing that explains why they win on the 4 tasks where bad loses despite being 7× faster overall.

### Gen 10 candidates (ranked)

I'm proposing 3 distinct candidates because the right Gen 10 depends on which tradeoff Drew prefers. **I'm not building any of them until you pick one.**

#### Candidate A — DOM index extraction (browser-use parity)

**What it is:** Add a new action `extractWithIndex(query)` that returns a numbered list of every visible element matching the query, with the element's textContent, attributes, and a stable selector. The LLM can then pick by index. Example:

```
elements found:
[0] <a> href="/package/react/v/19.1.0" text="19.1.0"
[1] <p> class="_9ba9a..." text="weekly downloads: 26,543,821"
[2] <button> text="Copy npm install"
...
```

The LLM responds with `extractIndex(1)` and gets back the full text. This is exactly how browser-use's per-action loop wins on the failing tasks.

**Pros:**
- Proven to work (browser-use's data shows it)
- Solves the root cause (visibility, not iteration)
- Works without vision (no extra cost per call)
- Fits cleanly into the existing action vocabulary

**Cons:**
- New action type requires planner prompt updates + new tests
- The element index can be huge on real-web pages (npmjs has ~800 elements) — needs filtering
- Doesn't help with vision-only extractions (e.g., text in a screenshot)

**Risk:** medium. The mechanism is well-understood and has prior art.

**Estimated effort:** 1 architectural change (new action), ~200 LOC, ~15 new tests.

#### Candidate B — Vision fallback on extraction failure

**What it is:** When `isMeaningfulRunScriptOutput` returns false (the helper we keep from Gen 9), the runner takes a screenshot and asks a vision-capable model "find the element matching `<query>` in this page, return its text content". Only fires on failures, so cost is bounded.

**Pros:**
- Reuses Gen 9 infrastructure (`isMeaningfulRunScriptOutput`, fall-through point)
- Solves vision-only cases the DOM index can't (e.g., text rendered in a `<canvas>` or screenshot-only data)
- Doesn't require planner prompt changes
- Atlas/Cursor use this — known to work

**Cons:**
- Vision calls cost ~5× a text-only call (~$0.05/call)
- Adds latency on the recovery path (~3-5s per screenshot)
- Failure semantics are fuzzy (LLM hallucinations on screenshots)

**Risk:** medium-high. Vision models can hallucinate. Need a verification step.

**Estimated effort:** 1 model integration, ~150 LOC, ~10 new tests.

#### Candidate C — Bigger ARIA snapshot + text content

**What it is:** Currently the snapshot budget is 16k chars on non-first turns and aggressively filters decorative elements. Gen 10C raises the cap to 32k for the first observation only, and stops filtering text content from `<dl>`, `<dt>`, `<dd>`, `<code>`, `<pre>` elements (the elements where the failing tasks hide their data).

**Pros:**
- Smallest change (~30 LOC)
- No new actions, no planner changes
- Just changes the data the LLM sees, doesn't change how it acts

**Cons:**
- May not be enough — the LLM still has to write selectors based on the snapshot, and the snapshot is still a *summary* not the live DOM
- Could regress the fast cases (more tokens per observation = more cost on the 70% that already work)
- Doesn't solve XHR-loaded data (npm) — the data isn't in the DOM yet

**Risk:** low (additive, easy to revert). Reward: probably modest (+1 or +2 tasks).

**Estimated effort:** trivial. ~30 LOC, ~5 tests.

### My honest ranking

**A > C > B.**

- **A (DOM index)** addresses the actual root cause (LLM visibility) and is the only candidate I expect to move pass rate by ≥3 tasks. It's also the most architectural change, which is the kind of change Gen 10 should be. We've already burned Gen 9 on a non-architectural recovery hack; Gen 10 should be the architectural fix.
- **C (bigger snapshot)** is the cheapest insurance and should ship regardless — it's a 30-LOC change and even a +1 task win is worth it. Could ship as Gen 9.5 alongside Gen 10.
- **B (vision)** is the right tool for *some* failures but the cost/latency tradeoff makes it Gen 11 material, not Gen 10. Vision should be the fallback after DOM-index, not the primary fix.

### Why this isn't another Gen 9

Gen 9 failed because it was a **mechanism change without a capability change**. The per-action loop already existed; Gen 9 just made it fire in more cases. But the *thing* that fires didn't get smarter, so it failed in the same way.

Gen 10A is a **capability change**: the LLM gets new information (numbered element list with text) that it didn't have before. That's a different category of change and the prior art (browser-use) shows it works on exactly the tasks bad fails on.

### Success criteria for Gen 10A

- Pass rate on the 10-task gauntlet ≥ 26/30 = 87% (5 reps, mean)
- No cost regression on previously-passing tasks (per-task mean cost ≤ Gen 8 + 10%)
- No wall-time regression > 2s on previously-passing tasks
- The new action has unit tests + an integration test that proves it returns the right element on a fixture page
- A live demo on npm shows the extractWithIndex output and the LLM picking the right index

### Risk mitigations baked in

1. **Hard cost cap** on the recovery path: if a single case exceeds 50K tokens, abort and report `success: false, reason: 'cost_cap_exceeded'`. This prevents the reddit-style death spirals we saw in Gen 9.1.
2. **Per-task budget tracking** in the bench harness — surface mean/p95/max cost per task so future regressions are visible immediately.
3. **A/B against Gen 8 head-to-head** with bootstrap CIs — no shipping unless the CI lower bound on pass-rate delta is positive AND no cost CI shows >2× regression on any task.

---

## Decision needed from user

**Pick one (or "ship A+C as Gen 10"):**
- **A only** — DOM index extraction (the big architectural fix)
- **C only** — bigger snapshot (the cheap insurance)
- **A + C** — ship both as Gen 10 (recommended)
- **B instead** — vision fallback (riskier, costs more, but solves a different class of failures)
- **none — propose something different** — what?

I will not start building until you respond. The Gen 9 lesson is exactly that "build first, validate later" is how non-improvements get shipped.
