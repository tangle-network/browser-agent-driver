---
'@tangle-network/browser-agent-driver': minor
---

**fanOut + VerticalBench integration asks.** Covers the two unreleased PRs merged to main without changesets (#70, #71).

### fanOut — parallel sub-task fan-out (#70)

- Wires `fanOut` into the action validator so the scout can emit it as a first-class action.
- Shorthand form: a single `subGoals[]` list, or `baseUrl + goalTemplate + items[]` for per-entity start URLs with `{item}` substitution in `baseUrl`.
- `BAD_FANOUT_CONCURRENCY` and `BAD_FANOUT_STAGGER_MS` env knobs for tuning without code changes.

### VerticalBench integration (#71)

- **scout JSON parse hardening.** `Brain.parse()` now tolerates prose-wrapped JSON ("Here's your response:\n{...}") via first-`{`/last-`}` extraction when `JSON.parse` fails after markdown-fence stripping. When the format-hint retry also fails with a custom `LLM_BASE_URL` set, emits a structured `scout_json_parse_failed` error naming the gateway as the likely cause.
- **`schemaVersion` on `<sink>/report.json`.** Top-level `schemaVersion: "1"` pinned from `TEST_SUITE_SCHEMA_VERSION` (exported from the package root). Bumps only on breaking shape changes.
- **New `bad snapshot` subcommand.** Headless, no-LLM accessibility-tree dump. Loads URL → dismisses consent → waits for chosen network state → emits aria snapshot + final URL + title + timing. JSON output pins `schemaVersion: "1"`. Exits non-zero on `chrome-error://` or aria-snapshot failure. Intended for deterministic DOM-level signal in CI pipelines where the agentic loop is overkill.
