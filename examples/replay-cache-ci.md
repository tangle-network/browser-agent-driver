# Verified-replay CI: rerun browser tasks at ~10–20% of live LLM cost

Recipe from the hillclimb program close-out
([docs/bench-2026-10-11-hillclimb-program.md](../docs/bench-2026-10-11-hillclimb-program.md)).
A CI suite that re-runs N browser tasks per PR normally pays ~N × $0.02 and
~20s wall per task live. With verified replay, reruns on an unchanged route
make **zero decide calls** and at most one verification call.

## How it works

1. The first green run persists the trajectory: goal digest + origin +
   route-normalized `:id` path + TTL.
2. Subsequent runs on the same route replay the recorded steps with zero
   decide calls — ~10–20% of the LLM cost, ~30–40% of the wall time.
3. Replay is **fail-closed**: a guard checks each action is performable
   against a fresh observation; any mismatch heals to the live agent (a few
   fast browser actions), so a stale replay is never worse than running live.
4. Staleness is measurable per run via `AgentResult.replay`
   (attempted/outcome/steps/llmCallsUsed in `report.json`).

## CI recipe

Persist the memory dir between runs — the replay cache lives there:

```yaml
# GitHub Actions sketch
- uses: actions/cache@v4
  with:
    path: .agent-memory
    key: bad-memory-${{ github.ref_name }}-${{ hashFiles('bench/**') }}
    restore-keys: bad-memory-${{ github.ref_name }}-
- run: pnpm bench:compete
  env:
    BAD_MEMORY_DIR: .agent-memory   # default; shown for clarity
```

- `BAD_MEMORY_DIR` (default `.agent-memory`) is the convention — archive it as
  a build artifact or cache it per branch.
- Cache keys are **route-normalized** (`:id` path segments), so a task whose
  URLs only differ in entity IDs still hits.
- First run on a cold cache is a normal live run; keep the artifact only when
  the run is green.
