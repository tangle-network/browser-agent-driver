---
'@tangle-network/browser-agent-driver': minor
---

feat(jobs): robustness layer + agentic orchestrator

Five hardening additions plus an LLM-driven control loop that wraps the runner. The architectural rule: protocols are deterministic (retry, anti-bot detection, schema gating) and judgment is agentic (when to re-sample broken wayback snapshots, retry vs. skip, conclude). Mixing those lines is how you end up paying LLM tax on exponential backoff.

**Deterministic foundation**
- `src/jobs/retry.ts` — whitelist-based retry with exponential backoff + jitter. Retries 429 / 5xx / network / timeout / fetch failures; everything else (4xx, anti-bot, schema, unknown) is treated as deterministic and not retried. Configurable per-error-class via `isRetryable`. Default: 3 attempts, 500ms base, 5s cap. Wired into `runJob` via `RunJobOptions.retryPolicy`.
- `src/jobs/anti-bot.ts` — pure pattern match against an audit's `report.json`. Title patterns (Cloudflare interstitial, "Just a moment...", "Access denied", etc.) and intent patterns plus a last-resort heuristic (zero findings + low classifier confidence + unknown type). When fired, the runner records `status: 'skipped'` with a reason instead of putting a bogus score on the leaderboard.
- `src/jobs/cost-history.ts` — adaptive cost estimate from prior job records. Uses static default until N≥3 completed jobs exist; afterward averages per-target cost from the last 20. Floors at 50% of the static default to prevent runaway optimism on a stretch of zero-cost claude-code jobs.
- Schema versioning: `tokens.json` is now stamped with `schemaVersion: 1` at write time; the aggregator refuses files older than `MIN_TOKENS_SCHEMA`.
- Resume: `bad jobs resume <jobId>` re-runs only targets that aren't already `ok`/`skipped`. `RunJobOptions.resume` exposes the same on the API.

**Agentic orchestrator**
- `src/jobs/orchestrator.ts` — `orchestrateJob(job, opts)` runs the deterministic fan-out via `runJob`, then enters a control loop only if intervention is warranted. `needsIntervention` is the gate: any failures, missing entries, or zero-scored wayback snapshots (broken archive captures) trigger the agent.
- LLM tool surface (5 tools): `getJobState`, `resampleWayback`, `retryTarget`, `markSkipped`, `concludeJob`. Hard caps: 2 retries per target, 1 resample per URL, cost ≤ `spec.maxCostUSD * 0.9`.
- Default brain uses the same `claude-code` provider as the audit pipeline (subscription-based, no API key required).
- CLI: `bad jobs orchestrate --spec <file.json>` runs the spec end-to-end with the agent layer. Same JSON spec as `create`.

**Tests:** +34 across `jobs-retry`, `jobs-anti-bot`, `jobs-cost-history`, `jobs-orchestrator` (deterministic gate), and `jobs-orchestrator-agent` (LLM path with `MockLanguageModelV3`). Total: 1494 passing.
