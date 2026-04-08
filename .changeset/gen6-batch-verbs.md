---
'@tangle-network/browser-agent-driver': minor
---

Gen 6 — Batch action verbs (`fill`, `clickSequence`).

The vision: turn count is the metric, not ms per turn. A 5-turn run at 3s/turn beats a 20-turn run at 2s/turn every time. Gen 4 + Gen 5 squeezed infrastructure overhead (~5–8% of wall time on a 20-turn run). The dominant cost is N × LLM call latency. The only way to make `bad` dramatically faster is to reduce N.

Gen 6 ships the minimal-viable plan-then-execute: higher-level action verbs that compress N single-step turns into 1 batch turn.

**New action verbs:**

- `fill` — multi-field batch fill in ONE action. Fills text inputs, sets selects, and checks checkboxes:
  ```json
  {
    "action": "fill",
    "fields": { "@t1": "Jordan", "@t2": "Rivera", "@t3": "jordan@example.com" },
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
- New brain prompt rule (#15) instructs the agent to prefer batch fill when 2+ form fields are visible
- Validation guards against empty payloads, non-string field values, and inverted ref formats
- Supervisor signature updated so the stuck-detector recognizes batch ops as distinct from single steps

**Tests:** 856 passing (was 840, **+16 net new**).
- 10 in `tests/batch-action-parse.test.ts` (parser, validation, error paths)
- 6 in `tests/playwright-driver-batch.test.ts` (real Chromium, fill text/selects/checks, clickSequence, fast-fail on missing refs)

**Tier1 gate:** 100% pass rate. No regressions.

**Long-form scenario (single-run, high variance):** When the agent picks batch fill it compresses 14–19 form fields into 2–3 turns. Aggregate turn count is dominated by run-to-run agent strategy variance — multi-rep measurement is needed for statistical claims.

**Followup tracked:** runner-injected batch hint when 3+ consecutive type actions are detected on the same form (more reliable than prompt rules alone).

**Also adds:** `bench/competitive/README.md` — scaffold spec for a head-to-head benchmark vs browser-use, Stagehand, Skyvern, OpenAI/Claude Computer Use. Not yet executed live.
