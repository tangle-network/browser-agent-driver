---
'@tangle-network/browser-agent-driver': minor
---

**Fleet telemetry + GEPA harness + multi-tenant identity.** Covers the unreleased work merged in PR #76.

### Fleet telemetry

Every `bad` invocation now emits structured envelopes to `~/.bad/telemetry/<repo>/<date>.jsonl` (configurable via `BAD_TELEMETRY_DIR`) and optionally POSTs to a remote collector via `BAD_TELEMETRY_ENDPOINT`. Schema is a strict superset of `@tangle-network/agent-eval`'s `Run` shape so a future TraceStore adapter can promote envelopes into traces without translation.

- `src/telemetry/{schema,sink,client,hash,index}.ts` — typed envelope, file + HTTP sinks, fanout, env-driven config, secret-redacting argv capture.
- Wired into the design-audit pipeline (`src/design/audit/pipeline.ts`) and CLI top level (`src/cli.ts`, `src/cli-design-audit.ts`) — per-page, per-evolve-round, and per-run envelopes.
- `pnpm telemetry:rollup` (`bench/telemetry/rollup.ts`) — local aggregation CLI with filters (`--repo`, `--kind`, `--since`, `--until`, `--json`). Surfaces per-repo×kind summaries, evolve outcomes, prompt-hash variance, and a recent-vs-baseline regression detector.

### Multi-tenant identity

New optional fields on `TelemetrySource` so hosts (bad-app, agent-platform) can attribute telemetry per workspace without leaking customer URLs:

- `source.tenantId?` — workspace / org identity
- `source.customerId?` — sub-tenant identity (suite/walkthrough/extraction id)
- `source.apiKeyHash?` — 12-hex SHA-256 prefix of the auth key

Driven by env vars set by the host when spawning sandboxes:

- `BAD_TENANT_ID` → `source.tenantId`
- `BAD_CUSTOMER_ID` → `source.customerId`
- `BAD_API_KEY_HASH` → `source.apiKeyHash`
- `BAD_PARENT_RUN_ID` → links child envelopes to a host-side parent run
- `BAD_SOURCE_REPO` → overrides repo identity inside sandboxes (where cwd-basename is meaningless)

### GEPA design-audit harness

Population-based reflective-mutation loop with Pareto frontier and golden-finding recall. Targets six knobs of the design-audit prompt stack:

- `pass-focus` — pass instruction text
- `few-shot-example` — per-pass example finding
- `no-bs-rules` — review heuristics
- `conservative-score-weights` — min/mean blend
- `pass-selection-per-classification` — `--audit-passes deep` bundles
- `infer-audit-mode` — domain → mode mapping

8 adversarial fixtures (6 controlled HTML pages with planted defects + 2 reference URLs as ceiling/stability checks) ship in-tree at `bench/design/gepa/fixtures/`.

- `pnpm design:gepa --target <id>` — production GEPA with reflective LLM mutator
- `pnpm design:gepa:smoke` — deterministic mutator, no LLM, ~30s CI smoke
- Reports land in `.evolve/gepa/<runId>/` (per-generation JSON + Markdown); summary appended to `.evolve/experiments.jsonl` with `category: 'gepa'`.

### evaluate.ts cleanup

- Per-pass `systemOpener` — the `trust` pass no longer claims "visual layer only" framing.
- Real per-pass `DEFAULT_FEW_SHOT_EXAMPLES` — replaced the broken `opacity: 0.72` placeholder with concrete pass-appropriate examples.
- `--audit-passes deep` is classification-aware (`DEFAULT_DEEP_PASSES_BY_TYPE`).
- `AuditOverrides` interface threaded through `EvaluateInput → pipeline → auditOnePage` so GEPA mutates every knob in-process; production runs leave `overrides` undefined.
- `conservativeScore` accepts weights as a parameter.

### cli-bridge provider

Local CLI-bridge HTTP proxy support across `Brain`, `config`, and types. New env vars: `CLI_BRIDGE_URL`, `CLI_BRIDGE_BEARER`, `CLI_BRIDGE_DEFAULT_HARNESS`.

### `Brain.complete(system, user)`

New public LLM hook for non-agent uses (GEPA reflective mutation, ad-hoc rubric authoring). Single round-trip through the configured provider/model with no decode-loop heuristics or tool dispatch.

### Tests

43 new tests across `tests/telemetry.test.ts`, `tests/design-audit-merge.test.ts`, `tests/design-audit-gepa-metrics.test.ts`. Suite at 1252 passing across 96 files post-merge.
