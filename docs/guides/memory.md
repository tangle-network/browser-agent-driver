# Memory System

Trajectory memory stores successful run recordings, domain-scoped knowledge, and session history, then injects them into subsequent runs as context for the LLM. Enabled by default.

## How It Works

Each run goes through: **observe → decide → execute → verify**. Memory improves the **decide** step by giving the LLM prior context about the domain, task, and what was accomplished in previous runs.

Four layers, all persisted to `.agent-memory/`:

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

### 2. Session History

Rolling log of the last 5 completed runs per domain. Each session records what the agent was asked to do, what it accomplished, and where it ended up:

```typescript
interface Session {
  id: string       // orchestrator-provided or auto-generated
  goal: string     // the task that was given
  outcome: string  // agent's own natural language result
  success: boolean
  finalUrl: string // where the browser ended up
  timestamp: string
  turnsUsed: number
  durationMs: number
}
```

Sessions enable **cross-run continuity** — when an orchestrator chains tasks like "build this app" → "now add auth," the agent sees what was already built and where the browser left off.

Sessions are recorded automatically at the end of every run. The `--session-id` flag lets an external orchestrator tag related runs with the same session ID for grouping:

```bash
bad run --task "Build a todo app" --start-url https://example.com --session-id proj_123
bad run --task "Add auth to the app" --start-url https://example.com --session-id proj_123
```

Injected as `SESSION HISTORY` at top priority in the brain context. The two most recent sessions get full detail (including final URL); older sessions are compressed to a single line.

### 3. App Knowledge

Domain-scoped facts learned across runs, with confidence scoring:

| Type | Example |
|------|---------|
| `timing` | "page load takes 5s after submit" |
| `selector` | "search box is `[data-testid='search']`" |
| `pattern` | "auth flow: click login → fill email → submit" |
| `quirk` | "uses shadow DOM for modals" |

Facts get confidence boosts on repeated confirmation and decay on contradiction. Pruned below 0.1 confidence. Injected as `APP KNOWLEDGE` in the brain context.

### 4. Selector Cache

Maps element identities (`button "Search"`) to known-good selectors, ranked by success count. Injected as `KNOWN SELECTORS` so the agent skips trial-and-error on familiar pages.

## Directory Layout

```
.agent-memory/
├── domains/
│   └── www.example.com/
│       ├── knowledge.json       # facts + session history
│       ├── selectors.json       # element → selector mappings
│       └── trajectories/
│           └── traj_*.json      # successful run recordings
├── agent-runs/
│   └── run_*.json               # per-execution manifests (orchestration API)
├── hints.json                   # cross-domain optimization hints
└── runs/
    └── run_*.json               # suite result summaries
```

`knowledge.json` stores both confidence-scored facts and the rolling session log:

```json
{
  "domain": "www.example.com",
  "facts": [
    { "type": "quirk", "key": "shadow-dom", "value": "uses shadow DOM for modals", "confidence": 0.8, "sources": 3, "lastSeen": "..." }
  ],
  "sessions": [
    { "id": "proj_123", "goal": "Build a todo app", "outcome": "Created project with TaskList component", "success": true, "finalUrl": "https://example.com/project/123", "timestamp": "...", "turnsUsed": 8, "durationMs": 45000 }
  ],
  "updatedAt": "..."
}
```

## Context Injection

Each turn, the runner builds a context budget with priority ordering:

| Source | Priority | Content |
|--------|----------|---------|
| Session history | 50 | What was accomplished in previous runs on this domain |
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

# tag runs with a session ID for cross-run chaining
bad run --goal "Build the app" --url https://example.com --session-id proj_123

# resume from a previous run (navigates to its finalUrl)
bad run --resume-run run_1710543210_abc --goal "Now add dark mode"

# fork a new session from a previous run
bad run --fork-run run_1710543210_abc --goal "Build auth instead"

# list recent runs
bad runs
bad runs --session-id proj_123 --json
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

## Run Registry (Orchestration API)

The `RunRegistry` provides a structured API for external orchestrators to enumerate, inspect, resume, and fork browser agent runs. While session history (above) serves the LLM's context window, the run registry serves the orchestration layer.

Manifests are stored as individual JSON files in `.agent-memory/agent-runs/`:

```typescript
interface RunManifest {
  runId: string        // unique per execution
  sessionId?: string   // groups related runs (orchestrator-provided)
  parentRunId?: string // set on resume/fork — tracks lineage
  status: 'running' | 'completed' | 'failed'
  goal: string
  domain: string
  startUrl?: string
  finalUrl?: string
  currentUrl?: string  // updated every 3 turns during execution
  startedAt: string
  updatedAt: string
  completedAt?: string
  success?: boolean
  summary?: string
  artifactPaths: string[]
  turnCount: number
  result?: string
  reason?: string
}
```

### API

```typescript
import { RunRegistry } from '@tangle-network/browser-agent-driver'

const registry = new RunRegistry('.agent-memory')

// Start a run (written at execution start)
const runId = registry.startRun({
  runId: RunRegistry.generateRunId(),
  sessionId: 'proj_123',    // optional grouping key
  goal: 'Build a todo app',
  domain: 'example.com',
  startUrl: 'https://example.com',
})

// Query runs
registry.getRun(runId)
registry.listRuns({ domain: 'example.com', status: 'completed', limit: 5 })
registry.listRuns({ sessionId: 'proj_123' })

// Resume: continue from where a previous run left off
const resume = registry.buildResumeScenario(runId, 'Add dark mode')
// → { goal: 'Add dark mode', startUrl: 'https://example.com/project/123', sessionId: 'proj_123', parentRunId: runId }

// Fork: branch off with a new session
const fork = registry.buildForkScenario(runId, 'Build a different app')
// → { goal: '...', startUrl: '...', sessionId: 'fork_...', parentRunId: runId }
```

### Design

Two separate substrates, one directory:

| Layer | File | Consumer | Purpose |
|-------|------|----------|---------|
| Session history | `knowledge.json` | LLM brain | Context for the agent's next decision |
| Run manifests | `agent-runs/*.json` | Orchestrator | Structured query/resume/fork API |

`sessionId` groups related runs into a continuation thread. `runId` uniquely identifies each execution. An orchestrator chains runs by passing the same `sessionId` across calls, and the agent automatically sees prior work through session history in its brain context.

## Impact

Validated on WebBench-50 (2026-03-10):

- 15% fewer turns on repeated domains
- 19% fewer tokens (cost reduction)
- 5 additional passes from faster navigation paths
- Cold start (first run): ~10% overhead from memory I/O
- Warm runs (2+): net positive on turns, tokens, and pass rate
