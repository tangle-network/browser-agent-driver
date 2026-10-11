# RFC: Driver-pluggable pivot — freeze the bespoke agent loop, keep the pipeline

**Status:** decided (owner, 2026-10-10) · **Date:** 2026-10-10
**Research:** [docs/sota-browser-agents-2026-10.md](../sota-browser-agents-2026-10.md)

## Decision

1. **The bespoke agent loop (`src/agent`, planner, recovery patterns) is frozen.**
   Bugfixes only. No new agent-loop features. Our 91.3% WebVoyager (Gen 25,
   April 2026) is mid-pack against browser-use Cloud's 97.0% Online-Mind2Web
   and a 99%+ leaderboard ceiling; closing that gap is not where our remaining
   leverage is.

2. **This repo's mission becomes: harness-agnostic browser-testing workflows.**
   Three pillars:
   - **Pluggable harness adapters behind existing seams.** The `Driver`
     interface (`src/drivers/types.ts`) stays for observe/act-style drivers
     (PlaywrightDriver, SteelDriver). Autonomous agent harnesses (browser-use)
     and suite runners (tester-army/e2e) integrate at the goal/suite level via
     `bench/competitive/adapters/` — the seam that already exists and already
     ran browser-use head-to-head in April.
   - **The evidence/artifact pipeline** (events.jsonl → report.json →
     run-capsule/storyboard → PR verdict) is the product. Every adapter lands
     artifacts in this format regardless of which engine produced the run.
   - **The competitive eval harness** (`pnpm bench:compete`, external oracle,
     ≥3-rep statistical rules) is the adoption pipeline for future SOTA
     engines: when a new harness appears, we benchmark it on our corpus and
     adopt it if it wins, with numbers.

3. **Wallet/DeFi testing (MetaMask-on-Anvil, `bench/wallet/`) is preserved**
   and will be repackaged over time as fixtures/plugins usable with any
   engine, not just the frozen bespoke loop. It is a genuine niche no OSS
   agent covers.

4. **`agent-browser-infra` and `agent-browser-farm` are frozen** unless a
   paying requirement pulls (on-chain settlement for the former,
   cross-browser/mobile for the latter — and if mobile pulls,
   tester-army/e2e's agent-device path is further along than our farm).

## Why

The market moved (see research doc): browser-use, tester-army/e2e,
Stagehand/Browserbase, and Playwright Test Agents productized our thesis and
gave much of it away free. What they don't ship: statistically rigorous
external-oracle comparison, an integrated evidence→review→CI→billing trail,
and wallet/DeFi coverage. That is the surviving product.

## Consequences

- New harness integrations go in `bench/competitive/adapters/` (or a future
  promotion of that seam into `src/`), never by growing the frozen loop.
- Bench results must follow the existing rigor rules; adapter spikes are
  `--allow-quick-check` smoke runs and are labeled as such.
- The bespoke loop's open follow-ups (e.g. planner extraction failure mode)
  are wontfix unless a bug, not a feature gap, is involved.
