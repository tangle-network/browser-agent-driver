# Memory System

Trajectory memory stores successful run recordings and domain-scoped knowledge, then injects them into subsequent runs as context for the LLM. Enabled by default.

## How It Works

Each run goes through: **observe → decide → execute → verify**. Memory improves the **decide** step by giving the LLM prior context about the domain and task.

Three layers, all persisted to `.agent-memory/`:

### 1. Trajectory Store

After a successful run, the full action sequence is saved:

```
Goal: "Search for smart watch reviews"
Steps (5 total):
  1. click @s3f51 (on https://aliexpress.com) [verified]
  2. type "smart watch" into @s3f51 [verified]
  3. click @b39a5 (on search results page) [verified]
  ...
```

On the next run with a similar goal on the same domain, the best-matching trajectory is found via word-overlap similarity (Jaccard, threshold 0.5) and injected into the LLM prompt as a `REFERENCE TRAJECTORY`. The agent follows or adapts the recorded steps instead of exploring blind.

Trajectories expire after 30 days (`traceTtlDays`). When trace scoring is enabled, matches are ranked by a weighted blend of similarity (60%), recency (20%), execution speed (10%), and verification rate (10%).

### 2. App Knowledge

Domain-scoped facts learned across runs, with confidence scoring:

| Type | Example |
|------|---------|
| `timing` | "page load takes 5s after submit" |
| `selector` | "search box is `[data-testid='search']`" |
| `pattern` | "auth flow: click login → fill email → submit" |
| `quirk` | "uses shadow DOM for modals" |

Facts get confidence boosts on repeated confirmation and decay on contradiction. Pruned below 0.1 confidence. Injected as `APP KNOWLEDGE` in the brain context.

### 3. Selector Cache

Maps element identities (`button "Search"`) to known-good selectors, ranked by success count. Injected as `KNOWN SELECTORS` so the agent skips trial-and-error on familiar pages.

## Directory Layout

```
.agent-memory/
├── domains/
│   └── www.example.com/
│       ├── knowledge.json       # accumulated facts
│       ├── selectors.json       # element → selector mappings
│       └── trajectories/
│           └── traj_*.json      # successful run recordings
├── hints.json                   # cross-domain optimization hints
└── runs/
    └── run_*.json               # suite result summaries
```

## Context Injection

Each turn, the runner builds a context budget with priority ordering:

| Source | Priority | Content |
|--------|----------|---------|
| Reference trajectory | 40 | Step-by-step guide from a similar past run |
| App knowledge | 30 | Domain facts (timing, patterns, quirks) |
| Selector cache | 25 | Known-good selectors for elements |

Higher priority items survive context budget trimming on long runs.

## CLI Flags

```bash
# enabled by default — disable for clean baseline runs
bad run --cases ./cases.json --no-memory

# custom directory
bad run --cases ./cases.json --memory-dir ./my-memory

# enable trace scoring (weighted match ranking)
bad run --cases ./cases.json --trace-scoring

# set trajectory expiry
bad run --cases ./cases.json --trace-ttl-days 14
```

## Config

```typescript
import { defineConfig } from '@tangle-network/browser-agent-driver'

export default defineConfig({
  memory: {
    enabled: true,           // default
    dir: '.agent-memory',    // default
    traceScoring: false,     // weighted ranking (off by default)
    traceTtlDays: 30,        // trajectory expiry
  },
})
```

## Benchmark Isolation

For A/B experiments, isolate memory to prevent leakage between runs:

```bash
# per-run isolation — each scenario gets its own memory scope
node scripts/run-scenario-track.mjs \
  --memory --memory-isolation per-run \
  --cases ./cases.json

# shared isolation — scenarios on the same domain share memory within one track run
node scripts/run-scenario-track.mjs \
  --memory --memory-isolation shared \
  --cases ./cases.json
```

## Impact

Validated on WebBench-50 (2026-03-10):

- 15% fewer turns on repeated domains
- 19% fewer tokens (cost reduction)
- 5 additional passes from faster navigation paths
- Cold start (first run): ~10% overhead from memory I/O
- Warm runs (2+): net positive on turns, tokens, and pass rate
