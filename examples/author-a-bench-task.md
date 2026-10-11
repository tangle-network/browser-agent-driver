# Authoring a bench task

How to add a task to the competitive benchmark corpus. A task is a single JSON
file in `bench/competitive/tasks/` that every framework adapter (bad,
browser-use, ...) can execute and that produces a deterministic pass/fail
verdict.

## The contract

The schema is [`bench/competitive/tasks/_schema.json`](../bench/competitive/tasks/_schema.json).
Required fields: `id`, `name`, `goal`, `oracle`. Canonical example:
[`bench/competitive/tasks/dashboard-extract.json`](../bench/competitive/tasks/dashboard-extract.json).

```json
{
  "id": "dashboard-extract",
  "name": "Dashboard metric extraction",
  "goal": "Open the dashboard at the start URL. Read the three top metric cards ... Then complete with that JSON object as your final result.",
  "startUrl": "__FIXTURE_BASE_URL__/complex.html",
  "fixture": "complex.html",
  "maxTurns": 15,
  "timeoutMs": 300000,
  "tags": ["extraction", "scraping"],
  "oracle": {
    "type": "json-shape-match",
    "expectedShape": { "totalUsers": "re:12,?847" }
  }
}
```

## Rules of thumb

- **The goal is handed to every framework verbatim.** Make it self-contained —
  no bad-specific flags, selectors, or hints.
- **Local fixtures** use the literal `__FIXTURE_BASE_URL__` placeholder as
  `startUrl` and name an HTML file under `bench/fixtures/` via `fixture`; the
  runner serves it statically and substitutes the base URL at execution time.
- **The oracle is external** — it checks end state (page text, final URL,
  structured result shape, selector content), never the agent's self-report.
  Oracle types: `text-in-snapshot`, `url-contains`, `json-shape-match`
  (regex values via `re:` prefix), `selector-state`.
- **Budget the task**: `maxTurns` and `timeoutMs` bound every framework
  equally. Extraction tasks on fixtures typically need ≤15 turns.

## Run it

```bash
pnpm bench:compete -- --frameworks bad,browser-use --tasks <id> --reps 3 \
  --model gemini-2.5-flash --baseline bad --out agent-results/competitive-<label>
```

Use ≥3 reps (repo rigor minimum; 5 for variance-heavy cells), same-day
same-machine controls, and never cite `--allow-quick-check` runs. Full
procedure: [docs/bench-2026-10-11-hillclimb-program.md](../docs/bench-2026-10-11-hillclimb-program.md).
