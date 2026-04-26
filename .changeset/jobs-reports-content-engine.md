---
'@tangle-network/browser-agent-driver': minor
---

feat(jobs+reports): comparative-audit jobs API + AI SDK report tool surface

Three new modules layered cleanly on top of the existing audit pipeline. Lets you declaratively audit N URLs (optionally expanded into M historical wayback snapshots each), aggregate the results, and emit shareable markdown reports — or expose the same data as AI SDK tools so a browser-side agent can answer ad-hoc questions.

**`src/jobs/`** — declarative comparative-audit jobs.
- `JobSpec` JSON describes targets + audit options + cost cap; `createJob` mints and persists; `runJob` fans out with bounded concurrency and crash-safe per-result writes to `~/.bad/jobs/`.
- Pre-flight cost estimate (`estimateCost`) refuses jobs that would silently spend more than `maxCostUSD`.
- `AuditFn` injection keeps the queue decoupled from Playwright/LLM for tests.
- CLI: `bad jobs create --spec <file.json>`, `bad jobs status <id>`, `bad jobs list`, `bad jobs estimate --spec <file.json>`.

**`src/discover/`** — turn a `DiscoverSpec` into audit targets.
- `wayback` source uses archive.org's CDX API to list captures, then samples `count` evenly across the time range.
- `list` source is a pass-through.
- Pluggable `fetch` for tests; status-200-only filter on by default so 4xx snapshots don't poison the job.

**`src/reports/`** — turn a job into an artifact.
- `aggregateJob` reads each per-target `report.json`, projects to `AggregateRow` (rollup, dimensions, ethics count). All numbers in any report flow through this — never an LLM.
- `leaderboard`, `longitudinalFor`, `compareRuns`, `tierBuckets` are pure functions over rows.
- `renderLeaderboard` / `renderLongitudinal` / `renderBatchComparison` produce deterministic markdown.
- `narrateReport(brain, body)` optionally prepends an LLM exec-summary; without `brain`, returns the deterministic body unchanged. Same contract as the audit-patches layer: agent narrates, code computes.
- `buildReportTools()` exposes a 7-tool AI SDK surface (`queryJob`, `fetchAudit`, `compareRuns`, `longitudinal`, `tierBuckets`, `renderTemplate`, `runFreshAudit`) so a browser-side agent can interrogate jobs without re-implementing aggregation.
- CLI: `bad reports generate --job <id> --template <leaderboard|longitudinal|batch-comparison> [--top N --by-type X --buckets 10,100 --narrate --out file.md]`.

**Tests:** +55 across `jobs-store`, `jobs-queue`, `jobs-cost-estimate`, `discover-wayback`, `reports-aggregate`, `reports-templates`, `reports-tools`. Total: 1448 passing.
