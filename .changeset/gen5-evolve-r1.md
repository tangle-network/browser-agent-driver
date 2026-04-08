---
'@tangle-network/browser-agent-driver': patch
---

Gen 5 / Evolve Round 1 — Persist + verify lazy decisions in production.

**Shipped (5 components):**
- **events.jsonl persistence** — TestRunner creates a per-test TurnEventBus that subscribes a `FilesystemSink.appendEvent(testId, event)` writer AND forwards every event to the shared suite-level live bus. The result: every `bad` run now writes `<run-dir>/<testId>/events.jsonl` with one JSON line per sub-turn event, replayable post-hoc.
- **`bad view` reads events.jsonl** — `findEventLogs(reportRoot)` discovers the per-test files alongside report.json and inlines the parsed events into the viewer via `window.__bad_eventLogs`. Tolerant of bad lines.
- **Lazy `detectSupervisorSignal`** — only computes when supervisor enabled AND past min-turns gate. Was unconditional every turn.
- **Lazy override pipeline** — only runs when at least one input that any producer might consume is non-null.
- **Pattern matcher fix for real ARIA snapshot format** — production snapshots use `- button "Accept all" [ref=bfba]` (YAML-list indent, ref AFTER name), not what the original test fixtures used. Both cookie-banner and modal matchers now extract ref + name independently of position. Regression test added against the real format.

**Bug found + fixed during measurement:** The pattern matcher gate was over-restricted by `!finalExtraContext`, which is always non-empty on pages with visible-link recommendations. Pattern matchers only look at the snapshot text — they don't consume extraContext or vision. Removed the gate from `canPatternSkip` (kept it on `canUseCache` because the cache replays a decision made under specific input conditions).

**Verified in production:** First end-to-end measurement of the lazy-decisions architecture. **LLM skip rate: 28.6%** on the cookie banner scenario (2 of 7 decisions skipped via deterministic pattern match). Zero LLM skips on happy-path goal-following long-form (expected — cache is for retry loops, not goal progression).

**Tier1 gate: 100% pass rate.** 840 tests pass (was 830, +10 net new).
