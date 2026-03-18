# CLAUDE.md

Browser Agent Driver (`bad` CLI) — general-purpose agentic browser automation.

## Gates

Required before merge:
- `pnpm lint` — type-check
- `pnpm check:boundaries` — architecture boundaries
- `pnpm test` — unit + integration (549 tests)
- Tier1 deterministic gate on PRs and `main`
- Tier2 staging gate when secrets available

## Mission

Reliable, performant completion of real user outcomes — for both persona-driven workflows and direct task inputs.

Non-goals: over-specializing for a single app; features without measurable completion gains.

## Defaults

- Model: `gpt-5.4`. Single-model unless `--model-adaptive` is set.
- Memory: ON by default. Disable with `--no-memory`.
- Wallet mode: only when `wallet.enabled=true` or extension paths provided.
- Evidence: `fast-explore` for iteration, `full-evidence` for release signoff.
- General-purpose first: Tangle personas/hints are optional, never required.

## Experiments

Adaptive routing (`--model-adaptive`), trace scoring (`--trace-scoring`) stay flagged until non-regressive vs control.

## Benchmark Tiers

- **Tier 1** (deterministic/local): 100% required.
- **Tier 2** (staging/auth): push to 100% through bug closure.
- **Tier 3** (open web): tracked separately; must not regress Tier 1/2.

Track: pass rate, median duration, token usage, artifact completeness.
Promotion: no pass-rate regression + meaningful latency/token improvement.

## Experiment Discipline

1. One variable at a time. Treat each hypothesis as a challenger spec.
2. Fast-explore sweeps first for broad testing. Full-evidence only for shortlisted winners.
3. Seeded AB (`ab:experiment --seed <fixed>`) for reproducibility.
4. Promote only when bootstrap CI lower bound is positive and Tier1/2 gates hold.
5. Memory isolation per run during benchmarks.
6. Stop early on unresolved provider quota/auth issues.
7. Parallelize repetitions within one experiment. One clean experiment at a time for promotion.
8. Keep pushing autonomously until baseline improves, challenger is rejected, or user input is needed.

## Research Pipeline

Automated hypothesis testing: `pnpm research:pipeline --queue bench/research/<queue>.json`

- **Two-stage** (recommended): `--two-stage` screens all hypotheses (1 rep), validates candidates (5 reps). ~40% cheaper than flat runs with better statistical power for winners.
- **Cost estimation**: `--estimate` shows expected cost before running.
- **Parallel hypotheses**: `--hypothesis-concurrency N` runs N hypotheses simultaneously.
- **Filtering**: `--max-priority N`, `--hypothesis <id>`, `--resume` to skip completed.
- **Decision logic**: `promote` (CI lower > 0, or neutral + efficiency gain), `reject` (CI upper < 0), `inconclusive`.
- Completed hypotheses get `priority: 99` + `result:` annotation in the queue file.

## Reliability Patterns (Learned)

**Fail fast on terminal blockers:**
- `chrome-error://`, bot challenges, missing API keys → abort immediately with reason.
- API key must match provider (don't let `OPENAI_API_KEY` route to `anthropic`).

**Page interaction:**
- Dismiss cookie/consent dialogs before form submissions. Re-verify action took effect after dismissal.
- Auto-submit search forms (press Enter after typing in `searchbox` role elements).
- Detect A-B-A-B oscillation (menu toggle loops) → redirect to search or direct URL.

**Budget management:**
- Action timeout: `min(30s, caseTimeout/8)` — prevents one stuck click from exhausting the run.
- Snapshot budget: filter decorative elements, 16k char cap on non-first turns.
- First-turn LLM calls must not consume the whole case budget.

**Verification:**
- Verifier sees `budgetSnapshot()`, same as agent (not raw snapshot).
- Rejection feedback escalates: first rejection → navigate to content; second+ → demand strategy change.

**Benchmarks:**
- Separate anti-bot/unreachable sites from core reliability scorecards.
- Supervisor should consume screenshots when available (behind config flag).
- Outer experiment concurrency `1` for promotion-grade studies.

## Wallet Testing

Wallet validation lives in `bench/wallet/`. Chromium-only (extension APIs are Chromium-specific).

**Setup (one-time):**
```bash
pnpm wallet:setup      # download MetaMask extension
pnpm wallet:onboard    # automate MetaMask first-run wizard
```

**Running:**
```bash
pnpm wallet:anvil      # start Anvil mainnet fork, seed 100 ETH + 10 WETH + 10k USDC
pnpm wallet:validate   # run all wallet cases
pnpm wallet:anvil:stop # stop Anvil
```

**Learned patterns:**
- MetaMask 13.x onboarding: Welcome → "I have an existing wallet" → "Import using SRP" → SRP textarea → password → analytics → "Open wallet".
- MetaMask's LavaMoat blocks `page.evaluate()` on extension pages. Use CDP (`DOM.focus`, `Input.insertText`) or coordinate-based `page.mouse.click()` + `page.keyboard.type()`.
- The SRP textarea is invisible to Playwright locators (LavaMoat scuttling). CDP `DOM.querySelectorAll` with `pierce: true` finds it. Focus via CDP, type via `keyboard.type()` (fires React-compatible input events). `insertText` sets value but doesn't trigger React onChange.
- "Open wallet" button stays disabled for ~20s during background sync. Force-click or navigate directly to `home.html`.
- Preflight `eth_requestAccounts` times out on first visit to any dApp — expected. The agent handles wallet connection during test turns.
- **Hybrid RPC interception** (cli.ts): only forward user-specific calls (eth_getBalance for wallet addr, eth_call/eth_estimateGas with wallet addr in from/data) to Anvil. Pool/protocol data goes to real endpoints. JSON-RPC normalization required: add `jsonrpc`/`id`, remove `chainId` (Aave omits standard fields). MetaMask's service worker RPC is handled separately by the HTTPS reverse proxy (rpc-proxy.mjs on port 8443) + host-resolver-rules.
- **Anvil fork freshness**: free RPCs (publicnode, 1rpc) retain ~128 blocks (~25min) of state. Always restart Anvil before test runs. `drpc.org` is most reliable free fork RPC. `run-wallet-validation.mjs` auto-restarts Anvil for defi suite.
- **Pre-warming**: setup-anvil.mjs caches Aave contract state after fork creation so Anvil doesn't need upstream for user-specific queries.
- `pnpm exec bad` doesn't work in dev (pnpm doesn't self-link bin entries). Use `node dist/cli.js` directly.
- Test wallet: `test test test...junk` mnemonic → `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`.
- Seed USDC via storage slot manipulation (`anvil_setStorageAt` on slot 9) — faster than whale impersonation.
- **DeFi validation (2026-03-12): 7/7 pass**, $0.98 total, 267s. Connect: 5/5 (Uniswap, Aave, 1inch, SushiSwap). Swap: 2/2 (Uniswap, SushiSwap). Supply: 1/1 (Aave ETH).
- MetaMask RPC config: MUST keep `networkClientId: "mainnet"` as `type: "infura"` — changing breaks MetaMask ("No Infura network client found"). Instead ADD a new `type: "custom"` endpoint with UUID clientId alongside Infura, set as default. Modify LevelDB at `.agent-wallet-profile/Default/Local Extension Settings/<extId>/` using `classic-level`. Key: `NetworkController`. Also update `SelectedNetworkController.domains`.
- Setup order: `pnpm wallet:setup && pnpm wallet:onboard && pnpm wallet:anvil && pnpm wallet:configure && pnpm wallet:validate`.

## Rollback

1. Runtime: `--no-memory` + disable adaptive routing → control defaults.
2. Wallet: restore legacy activation in `src/browser-launch.ts` if needed.
3. Full: revert feature commit on `main`.

## Roadmap

Canonical in [docs/roadmap/browser-agent-ops.md](docs/roadmap/browser-agent-ops.md).

## Skills

Canonical in `skills/`. Install via `npm run skills:install`.
