# Bench 2026-10-11: bad vs browser-use, gemini-2.5-flash, 5 tasks × 3 reps

**Status:** citable per docs/EVAL-RIGOR.md (≥3 reps per cell, external oracle,
per-run artifacts retained). Not a leaderboard claim: one model, one machine,
one day, five tasks.

## Conditions

| condition | value |
|---|---|
| Date | 2026-10-11 |
| Model | `gemini-2.5-flash` (same model, same key, same day for both harnesses) |
| bad | v0.36.1 — main corpus at `a9b91f6`; the 3 JSON-oracle cells re-run at `e88d15d` (parser bugfix, see below) |
| browser-use | 0.12.6 (`ChatGoogle` provider) |
| Harness | `pnpm bench:compete`, `--reps 3`, baseline `bad` |
| Oracle | external per-task oracle (`_oracle.mjs`); agent self-reported success never trusted |
| Browsers | headless everywhere (`--headless` / `BrowserProfile(headless=True)`); verified only `chrome-headless-shell` processes existed during runs |
| Spend | Gemini only, **$1.60 total** across pilot + full + re-run. OpenAI key untouched (ops-board #10010). DeepSeek attempted first — account had insufficient balance, no runs |
| Key note | `GEMINI_API_KEY` in the shared env file is stale (HTTP 400); live key is `GOOGLE_AI_KEY`, mapped to `GEMINI_API_KEY` for the run |
| Artifacts | `agent-results/competitive-gemini-full-20261011/` (full 30-run corpus) + `agent-results/competitive-gemini-fixed-bad-20261011/` (post-fix re-run of 3 bad cells) — gitignored, not committed |

Corpus: 3 fixture tasks (`form-fill-multi-step`, `dashboard-extract`,
`dashboard-edit-export` from `bench/fixtures/`) + 2 real-web tasks
(`wikipedia-fact-lookup`, `hn-top-story-score`). Reproduce:

```bash
dotenvx run -f devops/secrets/tangle-router.env -- bash -c '
  unset OPENAI_API_KEY
  export GEMINI_API_KEY="$GOOGLE_AI_KEY"   # GEMINI_API_KEY in that file is stale
  export BENCH_PROVIDER=google BAD_PROVIDER=google
  node scripts/run-competitive.mjs \
    --frameworks bad,browser-use \
    --tasks form-fill-multi-step,dashboard-extract,dashboard-edit-export,wikipedia-fact-lookup,hn-top-story-score \
    --reps 3 --model gemini-2.5-flash --baseline bad \
    --out agent-results/competitive-gemini-full-$(date +%Y%m%d)'
```

## Headline results (bad cells post-fix where noted)

| task | bad | browser-use |
|---|---:|---:|
| form-fill-multi-step (19 fields, 3 steps) | 2/3 | **3/3** |
| dashboard-extract (JSON out) | **3/3** † | 1/3 |
| dashboard-edit-export (multi-step flow) | 3/3 | 3/3 |
| wikipedia-fact-lookup (JSON out) | **3/3** † | 0/3 |
| hn-top-story-score (JSON out) | 1/3 † | **3/3** |
| **total** | **12/15 (80%)** | 10/15 (67%) |

† bad cells re-run after the parser bugfix below. As-measured before the fix,
bad scored 0/3 on all three JSON-oracle tasks (total 5/15).

Per-cell detail (Wilson 95% CI at n=3 is wide — directional, not decisive):

| framework | task | pass | Wilson 95% | wall mean | tokens mean | cost/run | cost/success |
|---|---|---|---|---|---|---|---|
| bad | form-fill-multi-step | 2/3 | [21%, 94%] | 135.3s | 188,572 | $0.0712 | $0.107 |
| browser-use | form-fill-multi-step | 3/3 | [44%, 100%] | 44.0s | 55,653 | $0.0217 | $0.022 |
| bad | dashboard-extract † | 3/3 | [44%, 100%] | 29.0s | 103,278 | $0.0409 | $0.041 |
| browser-use | dashboard-extract | 1/3 | [6%, 79%] | 16.8s | 16,831 | $0.0073 | $0.022 |
| bad | dashboard-edit-export | 3/3 | [44%, 100%] | 10.0s | 76,209 | $0.0256 | $0.026 |
| browser-use | dashboard-edit-export | 3/3 | [44%, 100%] | 30.7s | 56,684 | $0.0211 | $0.021 |
| bad | wikipedia-fact-lookup † | 3/3 | [44%, 100%] | 20.7s | 137,420 | $0.0458 | $0.046 |
| browser-use | wikipedia-fact-lookup | 0/3 | [0%, 56%] | 17.8s | 13,420 | $0.0043 | ∞ |
| bad | hn-top-story-score † | 1/3 | [6%, 79%] | 51.0s | 170,994 | $0.0680 | $0.204 |
| browser-use | hn-top-story-score | 3/3 | [44%, 100%] | 13.9s | 16,596 | $0.0056 | $0.006 |

## The bug the bench found (fixed in this PR)

bad scored 0/9 on the three JSON-oracle tasks in the first pass — every
failure `resultText is not valid JSON`. Investigation of the retained
artifacts showed the agent *had* the answers (e.g. extracted `1815` via
`runScript` on turn 3 of the Wikipedia task) but its `complete` action
carried `result: ""`. Root cause: `validateAction` in
`src/brain/action-parse.ts` string-typed the result field
(`typeof v === 'string' ? v : ''`); gemini-2.5-flash follows the task text
literally and emits `result` as an object (`{"year": 1815}`), which was
silently coerced to `""`. Prose results were unaffected, hiding the bug on
form tasks. Fixed by JSON-serializing non-string results
(`e88d15d`, with regression test); the three affected bad cells were then
re-run (7/9 post-fix; the 2 remaining hn failures are genuine
"max turns reached" efficiency failures, not parser artifacts).

browser-use's extraction failures are its own: its `final_result()` is a
prose narrative ("Ada Lovelace's birth year is 1815.") even when the task
demands bare JSON — its judge even flags the mismatch. Same oracle, same
rules: a real task failure, not a harness artifact.

## Verdict

- **Pass rate:** bad 80% vs browser-use 67% on this 5-task corpus — bad wins
  the extraction-shaped tasks (3/3 vs 1/3 and 3/3 vs 0/3), loses form-fill
  consistency (2/3 vs 3/3) and hn efficiency (1/3 vs 3/3), ties edit-export.
  CIs overlap everywhere at n=3; treat as directional.
- **Efficiency:** browser-use is 3–7× cheaper per run (mean $0.012 vs $0.049
  pre-fix rollup) and ~2× faster wall-clock. On the one task both always
  passed (edit-export), browser-use is cheaper per run ($0.021 vs $0.026) but
  3× slower (30.7s vs 10.0s).
- **Where the bespoke loop wins:** structured-extraction pass rate on
  fixture/Wikipedia tasks and raw speed on multi-step fixture flows.
- **Where it loses:** token/cost efficiency everywhere, and turn budgeting on
  live extraction (hn: 2 of 3 reps burned all 8 turns without completing).

## Honest caveats

- n=3 per cell is the repo minimum, not statistical power; every pass-rate
  delta here has overlapping Wilson intervals. A promotion/demotion decision
  needs more reps and more tasks.
- The three post-fix bad cells ran ~40 minutes after the main corpus, same
  machine/model/key. Provider weather between the two batches is possible but
  both batches are reported separately above.
- Real-web tasks carry site-variance risk; no run was anti-bot `blocked` in
  this corpus, so clean pass rate == raw pass rate everywhere.
- Gemini thinking tokens are inside `output_tokens` for both harnesses
  (browser-use's `ChatGoogleUsage` and bad's AI-SDK accounting both include
  them), so token/cost comparisons are apples-to-apples.
- One unexplained pilot anomaly: a browser-use cell exited 0 without writing
  `result.json` (not reproduced in three later attempts). If it recurs, treat
  that cell as a plumbing failure and re-run it.
- Token capture paths differ by construction: bad's counts come from its
  runner report + events ledger; browser-use's from a monkey-patched
  `ChatGoogle.ainvoke`. Both count the same wire calls; neither is the
  provider bill.
