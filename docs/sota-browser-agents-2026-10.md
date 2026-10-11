# SOTA: Browser Agents & Agentic E2E Testing — 2026-10-10

Survey of the AI browser-agent / browser-workflow-automation / agentic-e2e market
and an honest assessment of how `browser-agent-driver` + `bad-app` + the farm/infra
layer compare. Sources prioritized from the last 6–9 months.

## 1. tester.army/e2e

- **What**: TesterArmy is an agentic testing SaaS ("runs natural language tests on web
  and mobile apps, on every pull request or on a schedule"). `e2e` is its open-source
  (Apache-2.0) testing framework, released ~early Oct 2026; hit #1 on GitHub trending
  with ~3.2k stars within days (+1,398/day at peak).
- **How it works**: a test describes a goal in natural language; `agent.act(...)` /
  `agent.assert(...)` drive the app, with Playwright locators and assertions in the
  same test. The killer feature: **an agent step verified by a later assertion is
  recorded, and subsequent runs replay it with zero model calls until the app changes.**
  Web engine via Playwright (Chromium/Firefox/WebKit); mobile via `agent-device`
  (iOS/Android sims). Hosted execution via Kernel browsers and "smol machines"
  (warm Chromium microVMs per attempt). GitHub PR-comment reporter included.
  BYO model (subscription, API key, or local). Pre-1.0; APIs unstable; opt-out telemetry.
- **Pricing (SaaS)**: Hobby $99/mo (250 runs, 3 concurrent), Startup $299/mo
  (1,000 runs, 10 concurrent), Enterprise custom. 5 free runs to try.
- **Why it matters to us**: it is our thesis productized as OSS — NL goal → agent run →
  recorded replay → PR comment. Their "verified-step replay caching" is the
  record→replay-with-evidence loop done right, and they ship mobile, which we don't.
- Sources: https://github.com/tester-army/e2e · https://tester.army/pricing ·
  https://tester.army/open-source

## 2. Open-source browser agents — state of play

| Project | Stars (mid/late 2026) | License | Benchmark | Notes |
|---|---|---|---|---|
| Browser Use | ~106–113k | MIT | 89.1% WebVoyager (OSS); **97.0% Online-Mind2Web (Cloud, SOTA)** | Python+TS; $17M seed; Cloud at $0.02/browser-hr w/ stealth, CAPTCHA, residential proxies; stealth benchmark 81% across 71 Cloudflare/Akamai/PerimeterX/DataDome sites (Browserbase: 42%) |
| Stagehand (Browserbase) | — | MIT | — | TS; deterministic steps + AI escape hatch; Browserbase ~$67.5M raised, SOC 2 Type II; the "ecosystem pick" |
| Skyvern | ~22k | OSS + cloud | 85.8% WebVoyager (Aug 2026) | Vision-first; forms/portals; native 2FA/CAPTCHA; aimed at non-developer process owners |
| Steel.dev | — | Apache-2.0 | — | Open browser API, self-hostable, $0.08/browser-hr; maintains the community leaderboard (leaderboard.steel.dev) |
| Playwright MCP | ~36k+ | Apache-2.0 | — | Microsoft's official browser MCP; the de-facto way coding agents get a browser |
| BrowserOS | — | OSS Chromium fork | — | Consumer-side agentic browser (Atlas/Comet alternative); not a testing tool |
| Magnitude | — | — | 93.9% WebVoyager | Vision-first; see our docs/research/competitor-analysis-2026-03.md |

**Benchmark ceiling (per leaderboard.steel.dev, Oct 2026)**: WebVoyager 99.19%
(browser-control / Fable 5), Alumnium 98.5%, Surfer 2 97.1%. WebArena ~74.3%
(WebTactix/DeepSeek v3.2). OSWorld ~86% (Qwen3.8-Max). BrowseComp ~92%.
**Our 91.3% WebVoyager (Gen 25) is now mid-pack**, achieved cheaply ($0.09/task)
but no longer a differentiator on the number alone.

**What OSS does better than our driver**: raw success rate and stealth at scale
(Browser Use Cloud), mobile (e2e, farm-adjacent products), community velocity,
docs/ecosystem. **What it does worse / doesn't do**: statistically rigorous
head-to-head evaluation with an external oracle, integrated evidence→review→PR
loops, wallet/DeFi flows.

Sources: https://leaderboard.steel.dev/ · https://github.com/browser-use/browser-use ·
https://aiworkflowlab.dev/article/browser-use-vs-stagehand-vs-skyvern-vs-computer-use-2026 ·
https://scrapfly.io/blog/posts/best-ai-browser-agents ·
https://www.linkedin.com/posts/timur-gok-6a7074159_browser-use-published-a-proper-2026-web-scraping-activity-7454914171479007232-q90u

## 3. Agentic e2e testing — 2026 SOTA

- **Playwright Test Agents (v1.56)** — planner, generator, healer built into the
  default test framework; combined with Playwright MCP this makes "AI-generated,
  self-healing tests" a checkbox feature of the tool every team already has. The
  single biggest structural commoditization of our category.
- **Momentic** (YC W24): self-serve plain-English tests, intent-based self-healing
  locators; Chrome-only.
- **QA Wolf**: managed service (~$56M disclosed) moving toward self-serve.
- **Meticulous**: $15M Series A (2026); deterministic replay model → ~zero flake.
- **Octomind**: appears discontinued (per RFP.wiki comparison, 2026-07).
- **mabl / testRigor / Tricentis / Applitools**: enterprise incumbents with AI layers.
- **New wave**: TestSprite, Autonoma, Bug0, Pie — "autonomy over authoring."

Takeaway: the market converged on our exact positioning (NL goals, self-healing,
PR integration, evidence) — and much of it is now free (Playwright agents,
tester-army/e2e, browser-use).

Sources: https://www.refontelearning.com/blog/qa-automation-engineering-playwright-ai-test-agents ·
https://testquality.com/playwright-test-agents-mcp-architecture-2026/ ·
https://remote.qa/blog/qa-wolf-vs-bug0-vs-momentic-vs-qa-wolf ·
https://kanopylabs.com/blog/ai-testing-tools-meticulous-vs-momentic-vs-qa-wolf ·
https://www.rfp.wiki/artificial-intelligence/ai-augmented-software-testing-tools/octomind/momentic

## 4. Where value is concentrating

1. **Agent interface layer**: MCP browser servers (Playwright MCP, Chrome DevTools
   MCP) — commoditized; not a place to build a moat.
2. **Cloud browser infra**: Browserbase / Steel / Kernel / Anchor / Hyperbrowser /
   Browser Use Cloud — browser-hour pricing racing to $0.02–0.08; differentiation is
   stealth success rate and session replay, both hard to win long-term.
3. **Evals & credibility**: WebVoyager / WebArena / Online-Mind2Web / OSWorld /
   BrowseComp / ClawBench; Steel's public leaderboard is becoming the reference.
   Harness choice swings scores more than model choice — a credible, reproducible
   harness is itself scarce.
4. **Evidence formats**: Playwright trace + video + HAR are the standard; our
   report.json → session viewer → run-capsule storyboard is a differentiated
   layer on top, but small.

## 5. Our stack — honest assessment

**browser-agent-driver** (91.3% WebVoyager @ $0.09/task, Gen 25, gpt-5.4):
genuinely strong engineering — hybrid vision+DOM, multi-model role routing,
parallel tabs, CAPTCHA solving, design audit, wallet/MetaMask DeFi testing, and a
competitive-eval harness (external oracle, Wilson/bootstrap CIs, ≥3-rep rules) that
no competitor open-sources. But: feature work stalled ~Sep 2026 (recent commits are
CI-only), bench results on disk date to April, and the flagship number is now ~8
points behind SOTA.

**bad-app** (browser.tangle.tools): the real product — walkthroughs → suites → runs
from app/CLI/CI, recordings/screenshots/reports/share links, PR comments, billing
via capped Router/Sandbox service keys, SOC 2 audit logging. Blocked on the sidecar
image + orchestrator stability (per ROADMAP).

**agent-browser-farm**: session allocator over Browserless/Appium (Chrome→Android).
Last commits 2026-03-10. Overlaps Browserless/Steel/Kernel; stale.

**agent-browser-infra**: still the unmodified "Hello World" Tangle blueprint
scaffold. The on-chain settlement-for-browser-work story is **not built**.

### Where we still have an edge
- **Evidence + review trail** as a first-class product (trace → viewer → shareable
  video → PR verdict), with billing/settlement discipline nobody else has.
- **Eval rigor**: external-oracle competitive benchmarking with statistical rules —
  valuable as both internal tooling and public credibility.
- **Wallet/DeFi testing**: MetaMask automation on Anvil forks across Uniswap/Aave/
  etc. — a real niche no OSS agent covers.

### Where we're behind
- Raw task success (91.3% vs 97–99% SOTA) and stealth at scale (BU Cloud 81% on
  protected sites, benchmarked publicly).
- Mobile (we have none in the driver; e2e ships iOS/Android).
- Community, docs gravity, and momentum (100k+ stars vs internal repo).
- Replay caching of verified agent steps (tester-army/e2e's core trick) — we don't
  have deterministic cheap replay of agent-verified flows.

## 6. Recommendation: wrap-OSS (keep the product, swap the engine option)

**Keep**: bad-app (evidence/review/CI/billing), the Driver abstraction, the
competitive-eval harness, wallet/DeFi testing.

**Wrap/swap**: add browser-use (and/or Stagehand) as first-class drivers behind the
existing `Driver` interface; our `bench:compete` harness already knows how to run
browser-use head-to-head — use it to decide, with numbers, whether our bespoke loop
still earns its maintenance. Adopt verified-step replay caching (the e2e pattern)
so passing runs replay model-free.

**Cut or freeze**: the bespoke stealth/CAPTCHA arms race (rent it from Steel/BU
Cloud via existing SteelDriver); agent-browser-infra's on-chain blueprint unless a
paying settlement requirement appears; agent-browser-farm unless cross-browser/
Safari/mobile becomes a customer pull (if it does, e2e's agent-device path is
further along).

### Three highest-leverage next moves
1. **Driver-pluggable bad-app**: ship the browser-use/Stagehand adapter, run the
   existing ≥3-rep external-oracle comparison (bad vs browser-use vs Stagehand on
   the same corpus), publish the result. The product becomes "evidence + review +
   CI for whichever agent engine wins."
2. **Own the wallet/DeFi wedge**: package MetaMask-on-fork testing + evidence as the
   flagship differentiated use case (dapp release checks with fund-movement proof).
   Nobody else is close.
3. **Productize the rigor**: turn `bad competitive` + the bench harness into a
   public "prove your agent's claim" artifact; submit verifiable scores to
   leaderboard.steel.dev. Cheap credibility that also dogfoods the evidence layer.

---
*Compiled 2026-10-10 from local repos (/Users/drew/webb/{browser-agent-driver,
bad-app, agent-browser-farm, agent-browser-infra}) and the sources cited above.*
