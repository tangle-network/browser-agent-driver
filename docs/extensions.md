# bad extensions

Customize bad's agent loop and design audits without forking the codebase.

## What you can extend

| Hook | What it does | Use cases |
|---|---|---|
| `onTurnEvent(event)` | Subscribe to every sub-turn event the runner emits | Slack notifications, custom logging, third-party telemetry |
| `mutateDecision(decision, ctx)` | Replace or modify the agent's chosen action before execute | Per-app safety rules ("never click delete"), domain constraints, action veto |
| `addRules.{global,search,dataExtraction,heavy}` | Append rules to specific system-prompt sections without overwriting `CORE_RULES` | Project-specific instructions, team conventions |
| `addRulesForDomain[host]` | Inject extra rules only when the agent visits a matching URL | "On stripe.com, prefer the Dashboard nav over marketing search" |
| `addAuditFragments[]` | Register design-audit rubric fragments programmatically | Custom dimensions ("crypto trust signals"), per-team scoring rubrics |

## Quick start

Create a `bad.config.mjs` in the directory where you run `bad`:

```js
// bad.config.mjs
export default {
  // Add a rule that fires only when the page has search affordances
  addRules: {
    search: 'Always include the currency symbol when extracting prices.',
  },

  // Add per-domain rules (matched as substrings of the URL hostname)
  addRulesForDomain: {
    'stripe.com': {
      extraRules: 'On stripe.com, prefer the Dashboard nav over the marketing site search.',
    },
    'github.com': {
      extraRules: 'On github.com, the cmd+k command palette is faster than clicking through repo menus.',
    },
  },

  // Subscribe to every event the runner emits
  onTurnEvent(event) {
    if (event.type === 'execute-completed' && !event.success) {
      console.log(`[my-extension] action failed: ${event.error}`)
    }
  },
}
```

bad auto-discovers `bad.config.{ts,mts,mjs,js,cjs}` from the cwd on every run. No flag needed.

To load extensions from explicit paths:

```bash
bad <goal> --extension ./path/to/ext-a.mjs --extension ./path/to/ext-b.mjs
```

Multiple `--extension` flags are merged with the auto-discovered config (auto-discovered loads first, explicit paths after).

## Hook reference

### `onTurnEvent(event)`

Called for every event the runner emits. The event types are:

| Type | Fired when |
|---|---|
| `run-started` | A new agent run begins |
| `turn-started` | A new turn begins |
| `observe-started` / `observe-completed` | Snapshot phase |
| `decide-started` / `decide-completed` | LLM decide phase |
| `decide-skipped-cached` | Decision was served from the in-session cache |
| `decide-skipped-pattern` | Decision was matched against a deterministic pattern (cookie banner etc.) |
| `execute-started` / `execute-completed` | Action execution phase |
| `verify-started` / `verify-completed` | Post-action verification phase |
| `recovery-fired` | The recovery analyzer triggered a forced action |
| `override-applied` | A built-in override or extension `mutateDecision` modified the decision |
| `turn-completed` | Turn finished — full Turn artifact attached |
| `run-completed` | Run finished — success/totalTurns/totalMs attached |

Example: post a Slack message on every turn that fails verification.

```js
import https from 'node:https'

export default {
  onTurnEvent(event) {
    if (event.type === 'verify-completed' && !event.verified) {
      const payload = JSON.stringify({
        text: `Turn ${event.turn} failed verification: ${event.reason}`,
      })
      const req = https.request(process.env.SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
      })
      req.on('error', () => {}) // best-effort
      req.write(payload)
      req.end()
    }
  },
}
```

### `mutateDecision(decision, ctx)`

Called after the LLM (or cache / pattern) produces a decision but BEFORE the runner executes it. Return a new `BrainDecision` to override, or `undefined`/the original to leave it unchanged.

The `ctx` argument provides:
- `goal` — the original task goal
- `turn` / `maxTurns` — current position in the turn budget
- `state` — the full PageState the decision was based on (url, title, snapshot, screenshot if vision is on)
- `lastError` — the previous turn's error message, if any

Example: veto any `click` action whose target text matches "delete":

```js
export default {
  mutateDecision(decision, ctx) {
    if (decision.action.action !== 'click') return
    // Find the element line in the snapshot for this ref
    const ref = decision.action.selector?.replace(/^@/, '')
    if (!ref) return
    const line = ctx.state.snapshot
      .split('\n')
      .find((l) => l.includes(`[ref=${ref}]`))
    if (line && /delete|remove|drop/i.test(line)) {
      console.log(`[safety] vetoing destructive click: ${line.trim()}`)
      return {
        ...decision,
        action: { action: 'abort', reason: 'extension safety rule blocked destructive click' },
      }
    }
  },
}
```

`mutateDecision` errors are caught and logged — a broken extension cannot crash the run.

### `addRules.{global,search,dataExtraction,heavy}`

Each section is appended to the matching part of the system prompt:

- `global` — appended after `REASONING_SUFFIX` on every turn
- `search` — appended only when the page has search affordances or `/search` is in the URL
- `dataExtraction` — appended only when the goal mentions extraction-related keywords
- `heavy` — appended on large snapshots (>10KB) or late in the run (turn > 10)

Example: enforce a project convention.

```js
export default {
  addRules: {
    global: 'When you complete the run, include the URL of every page you visited in the result.',
    search: 'Search results from `pkg.go.dev` are authoritative for Go module questions; prefer them over other sources.',
  },
}
```

The injected rules land in a separate slot AFTER the cached `CORE_RULES` prefix, so they don't invalidate Anthropic prompt caching from Gen 4.

### `addRulesForDomain[host]`

Per-domain rules that fire only when the URL hostname contains the key as a substring.

```js
export default {
  addRulesForDomain: {
    'stripe.com': {
      extraRules: 'On stripe.com, the Dashboard search is faster than navigating menus.',
    },
    'docs.': {
      // Matches any hostname starting with `docs.`
      extraRules: 'On docs subdomains, the search box is usually in the top-right header.',
    },
  },
}
```

Multiple matching rules are concatenated in registration order.

### `addAuditFragments[]`

Register custom design-audit rubric fragments programmatically. Same shape as on-disk fragments under `~/.bad/rubrics/`, but in-memory.

```js
export default {
  addAuditFragments: [
    {
      id: 'crypto-trust-signals',
      title: 'Crypto trust signals',
      weight: 'high', // 'critical' | 'high' | 'medium' | 'low'
      dimension: 'trust', // optional custom dimension
      appliesWhen: { domain: ['crypto'] }, // matches the page classification
      body: `
Score the page on visible trust signals for a crypto application:
- Smart contract audit reports (linked from header or footer)
- SOC2 / ISO certifications
- Founder transparency (named team, LinkedIn links)
- Bug bounty program
- On-chain treasury / runway disclosures
`,
    },
  ],
}
```

Fragments are evaluated alongside the built-in rubric fragments under `src/design/audit/rubric/fragments/` and any user fragments under `~/.bad/rubrics/`.

## Multiple extensions

Pass multiple `--extension` flags or combine bad.config + explicit paths. Rules from multiple extensions are concatenated. Listeners fan out to every extension. `mutateDecision` runs in registration order — later extensions see the previous extension's mutated decision.

## Disabling

Set `BAD_DECISION_CACHE=0` to disable the in-session decision cache.
Set `BAD_PATTERN_SKIP=0` to disable deterministic pattern matching (cookie banner, modal close).
Set `BAD_NO_WARMUP=1` to disable provider connection pre-warming.

## Limitations

- Extensions run in-process. A slow `onTurnEvent` or `mutateDecision` blocks the agent loop.
- Extensions cannot add new action types — the runner's executor only knows the built-in action verbs.
- Extensions cannot modify the system prompt's `CORE_RULES` directly; use `addRules` to append per-section instead.
- `bad.config.ts` requires the runtime to support TypeScript loading (Node 22+ with `--experimental-strip-types` or run via `tsx`). Use `.mjs` if you need broad compatibility.

## Live observability

Pair extensions with `bad <goal> --live` to watch the agent run in real-time:

```bash
bad "fill the form on https://example.com" --live
```

This opens a browser tab with the bad viewer in live mode. The viewer subscribes to the same `TurnEventBus` that your extensions consume — every event you can react to programmatically also shows up visually.
