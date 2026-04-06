# bad / bad-app — World-Class Spec & Priority Checklist

This is the principal-eng strategic plan for taking bad and bad-app from "best agent capabilities, weakest observability/distribution" to "world-class on every dimension."

**Companion to:** [browser-agent-ops.md](./browser-agent-ops.md) (operating cadence) and the design audit pursuit history in `.evolve/pursuits/`.

**Status:** active. Updated as items ship. Last revision: 2026-04-06.

---

## TL;DR — top 5 wedge moves

1. **Session viewer + cursor/highlight visualization** — table stakes. Every competitor has it. Highest visibility ROI per engineering dollar. Without this, bad is invisible.
2. **bad-app cloud with multi-tenancy + API + billing** — turns the open-source agent into a commercial business. bad-app is meant to be commercial, so this is P0.
3. **Reference library + comparative scoring for design audit** — actionability multiplier. Turns "score: 7" into "you're 2 points behind Vercel in spacing."
4. **GitHub Action / CI integration** — distribution wedge. Drop bad into any PR pipeline in 30 seconds.
5. **`SteelDriver` (and BrowserbaseDriver) adapter** — delegate anti-bot infra to specialists. Frees us to focus on the agent layer where we win.

---

## The strategic position

bad has the **best agent capabilities** in the space (design audit, evolve loops, wallet automation, knowledge memory) and the **worst observability/distribution**. That's an asymmetric advantage — capabilities are the hard part to build, observability and distribution are 1-2 quarters of focused engineering.

**Competitive landscape:**
- **Steel / Browserbase / BrowserCat / HyperBrowser** — pure infra plays. They don't own the agent layer. They sell remote browser sessions to developers building agents. Their moat is anti-bot infra (proxies, CAPTCHA, fingerprints) and observability (live session viewers).
- **browser-use / Magnitude / Notte / Skyvern / Stagehand** — agent frameworks. They own the agent loop but lack specialization (design audit, wallet, evolve).
- **OpenAI Computer Use / Claude Computer Use** — foundation model + browser access. Different abstraction; you build the loop.

**Our position:**
- bad sits in the agent framework category but with deeper specialization than any competitor
- bad-app sits in the managed-agents category (one layer above Steel's managed-browsers category)
- The play is: ship demo magnetism, sell agent endpoints, build cloud infra. In that order.

---

## Section 1 — Observability & Replay

**Why this is P0:** bad runs Playwright headless. Users can't see what it does. Every competitor has a session viewer. We have the data (artifacts per turn) but no UI.

### Why we don't have it yet
- bad started as a CLI that dumps JSON + screenshots to disk
- Adding a viewer requires choosing a frontend surface (TUI, desktop, web)
- We've been deferring it because the artifact-based workflow "works" — but it's invisible. **You can't sell what you can't show.**

### Session viewer — what to build

**Goal:** see bad doing things, both live and on replay, with the same fidelity Steel and Browserbase show.

**MVP scope:**
- Web app (Vite + React SPA), deployable as static asset OR served from bad-app
- Local mode: read run artifacts from disk
- Cloud mode: read from bad-app's session API
- Three views per run: **Live**, **Replay**, **Inspect**

**Live mode:**
- Stream the current screenshot via SSE/WebSocket as bad runs
- Show current turn: action JSON, reasoning, expected effect
- Show LLM call status (token count streaming, latency)
- Recovery events flagged inline
- Cancel button (sends SIGTERM)

**Replay mode:**
- Scrubber across turns (← → keys)
- Per turn: screenshot + a11y tree (truncated, expandable) + decision JSON + execution result
- Diff toggle: see what changed between turn N-1 and turn N
- Speed control (1x, 2x, 5x, instant)
- Bookmark / annotate any turn

**Inspect mode:**
- Click any element in the screenshot → highlight + show its `@ref` and a11y tree entry
- Search across all action JSON, snapshots, reasoning
- Cost breakdown per turn

**Priority:** P0.

### Cursor + highlight overlays

This is where the demo magic lives. Two parts:

**A. Cursor visualization during the run**
- Inject a JS overlay (`addInitScript`) that renders a fake cursor sprite at coordinates we control
- Before every `click` action, the runner POSTs target coordinates to the overlay; overlay animates the cursor moving there over ~200ms
- Screenshots are captured AFTER the cursor reaches the target so the cursor shows up in the recording
- Result: every replay shows a cursor moving around the page like you're watching a person

**B. Element highlight overlay**
- Same overlay system: when bad observes the page, draw a translucent box around every interactive element
- When bad picks one to act on, that box turns solid and pulses
- Captured in screenshots → replay shows what bad was looking at AND what it picked
- Toggleable via `--show-cursor` flag

**Priority:** P0.

### Time-travel debugging

- Each turn saves: full DOM HTML, screenshot, JS context
- Replay can step backward / forward
- "Re-run from this turn" button — fork the run, replace the LLM decision with a manual one, watch what happens

**Priority:** P1.

### Run dashboard

- Aggregate view across runs: pass rate, p50/p95 duration, cost, recovery events
- Search by goal, URL, model, date
- Cluster by failure mode (we already have a failure taxonomy)
- Trendline over time

**Priority:** P0 (cloud) / P1 (local).

---

## Section 2 — bad-app cloud (commercial product)

bad-app is meant to be commercial. This section is P0.

### Core platform

- **Multi-tenant API**
  - `POST /v1/runs` — enqueue a run, returns run_id
  - `GET /v1/runs/:id` — fetch result
  - `GET /v1/runs/:id/stream` — SSE stream of turns as they happen
  - `POST /v1/audits` — design audit endpoint
  - `POST /v1/evolve` — evolve loop endpoint
  - `GET /v1/sessions/:id/viewer` — link to session viewer
- **Workspace / org / team model**
  - Workspaces own runs, billing, members, integrations
  - RBAC: owner / member / viewer
  - API keys scoped to workspace
- **Auth**: Clerk / WorkOS / equivalent
- **Billing**: Stripe + metered usage
  - Per-task pricing (audit, run, evolve)
  - Tiered subscriptions (free / pro / business / enterprise)
- **Quota enforcement**: rate limits per workspace, hard caps
- **Webhooks**: workspace-level destinations, signed payloads, retries

### Tangle sandbox integration (the differentiator)

- Runs execute in Tangle sandboxes for isolation
- Each sandbox is ephemeral, sealed, deterministic
- Optional Tangle attestation per run (cryptographic proof)
- Compliance angle: auditable agent runs for finance / legal / healthcare

### Storage & retention

- Artifact CDN (S3 + CloudFront or Cloudflare R2)
- Configurable retention: 7d free / 30d pro / 365d enterprise
- Export to user's S3 bucket (BYOS)
- Encryption at rest, customer-managed keys for enterprise

### Compliance

- SOC 2 Type II
- GDPR DPA
- HIPAA (later)
- VPC deployment for enterprise

---

## Section 3 — Anti-bot & Reliability

bad's stealth is decent (patchright, JA3 fingerprint) but not Steel-tier.

### Recommended approach: SteelDriver adapter
- Implement bad's `Driver` interface against Steel's session API
- `bad run --driver steel --steel-api-key $STEEL_KEY --goal "..."`
- bad's agent loop runs locally; the browser runs in Steel's cloud
- Customers pay Steel for infra, pay us for the agent layer
- Same approach for Browserbase, BrowserCat, HyperBrowser

**Priority:** P0. SteelDriver in week 1.

### Native infra (only if customer demand justifies)
- Residential proxy pool
- Rotating fingerprints
- CAPTCHA solver integration (CapMonster, 2Captcha, Anti-Captcha)
- Per-session fingerprint stickiness
- IP geolocation matching

**Priority:** P2 unless customers demand it.

---

## Section 4 — Design Audit deepening

This is our wedge. Double down.

### Reference library
- Embed fingerprints for 30-50 reference sites (Linear, Stripe, Vercel, Apple, etc.)
- Each fingerprint: token extraction + design system score breakdown + overall score
- After auditing a target, find nearest matches via cosine similarity
- Surface in report: "Closest match: Vercel marketing (8.7/10). You're 2 points behind in spacing."
- Build the corpus via `bad design-audit --capture-reference --url X`

**Priority:** P0. The actionability multiplier.

### Continuous monitoring
- `bad design-audit --watch --url https://prod.example.com --interval 1h`
- Or scheduled via cron / GitHub Action
- Alert on regressions (Slack, email, webhook)
- Trend dashboard

**Priority:** P1.

### Per-fragment scoring extension
- Each rubric fragment can declare multiple dimensions
- Per-fragment confidence
- Custom rubric authoring UI in bad-app

**Priority:** P2.

### A/B test harness for design changes
- `bad design-audit --ab --before main --after my-branch`
- Audit both, diff scores, surface what got better/worse
- GitHub Action: comments PR with design impact

**Priority:** P1. Pairs with CI integration.

### Audit history per project
- Local SQLite database in `~/.bad/audits.db`
- `bad audits` lists past runs
- `bad audits diff <id1> <id2>` compares
- Cloud version: same in bad-app

**Priority:** P1.

### Live preview of CSS evolve overrides
- During `--evolve css`, open a browser window with live page + injected CSS
- "Accept" button writes CSS to file or commits to git

**Priority:** P2.

---

## Section 5 — Evolve loop deepening

### Cost & token tracking per round
- Each round logs LLM tokens, agent CLI cost, total $
- Display in evolve report
- Hard cost cap: `--evolve-budget 5.00`

**Priority:** P1.

### Parallel evolve (race agents)
- `bad design-audit --evolve "claude-code,codex,opencode"`
- Three agents fix the same findings in parallel sandboxes
- Re-audit each, pick the highest score delta
- Surface diffs between approaches

**Priority:** P1. Killer demo.

### Reference-grounded evolve
- Combine reference library + evolve
- `bad design-audit --evolve claude-code --target-style stripe.com`
- Audit user's site, fetch Stripe's tokens, instruct agent to bring user closer to Stripe
- Score against Stripe-similarity, not absolute quality

**Priority:** P0 once reference library exists.

### Rollback / cherry-pick
- Each round commits to a temp branch (or saves a patch)
- Review and accept/reject per round
- Revert to any prior round

**Priority:** P1.

### Cross-project memory
- Learned fix patterns shared across audits in the same workspace
- Pattern library: top fixes ever applied, ranked by success rate

**Priority:** P2.

---

## Section 6 — Developer Experience

### TUI for live runs
- Replace scrolling JSON with a real TUI (`ink`)
- Three panes: live screenshot (sixel/ASCII), current decision, log

**Priority:** P1.

### Interactive REPL mode
- `bad repl --url https://example.com`
- Type goals one at a time, agent runs them as mini-tasks, leaves page in place
- Like Playwright codegen but driven by natural language

**Priority:** P1. Killer demo.

### VS Code / Cursor extension
- Right-click a URL → "Audit this with bad"
- Right-click on localhost dev server → "Run agent test"
- Inline display of audit findings as a custom view
- Codelens above CSS rules: "Used in 47 places, contrast fails AA"

**Priority:** P1.

### GitHub Action
```yaml
- uses: tangle-network/bad-action@v1
  with:
    url: ${{ steps.deploy.outputs.preview_url }}
    profile: vibecoded
    fail-on-score-drop: 0.5
    evolve: false
```
- Comments on PR with audit results
- Optionally posts top fixes as PR review comments
- Optionally opens auto-fix PR via evolve loop

**Priority:** P0. Distribution wedge.

### GitLab CI / CircleCI / others
- Same idea, different runners

**Priority:** P1.

### Slack / Discord notifications
- Webhook sink already exists. Extend with rich Slack blocks, Discord embeds.

**Priority:** P2.

### CLI prompt UX
- `bad init` interactive setup wizard
- `bad doctor` checks env (Node, Playwright, API keys, claude-code CLI)
- Better error messages with suggestions

**Priority:** P1.

---

## Section 7 — Documentation & Onboarding

### Tutorial videos
- 60-second intro
- 5-minute quickstart
- 10-minute design audit + evolve loop demo
- Feature spotlights

### Recipes / cookbook
- "Audit a Next.js app"
- "Run agent tests in CI"
- "Wire up wallet automation for your DEX"
- "Build a custom rubric for your design system"
- "Use bad as a library inside your test suite"

### Migration guides
- "Coming from Playwright codegen"
- "Coming from browser-use"
- "Coming from Cypress"

### Architecture deep-dive
- The Brain. The Driver. The Runner. The Memory.
- Sequence diagrams for a single turn
- Recovery decision tree

### API reference
- Autogenerated TypeDoc
- OpenAPI spec for bad-app

### Troubleshooting guide
- Top 20 errors and fixes
- "My run is stuck" decision tree
- "My audit is uncalibrated" debugging steps

**Priority:** P0. Documentation has the highest leverage per dollar.

---

## Section 8 — Quality & Infrastructure

- Fix the 2 flaky Playwright integration tests
- Reproducibility test in CI: audit Stripe / Linear / Apple, assert ≥ 8
- Snapshot golden files for evaluator inputs/outputs
- Fuzzing the audit prompt parser
- Boundary check rules for `src/design/audit/`
- Performance benchmarks for the audit pipeline (where's the bottleneck?)

**Priority:** P1 each, P0 collectively.

---

## Section 9 — Distribution & Growth

### Landing page
- Hero: "Watch bad audit your site → live demo"
- Demo widget: type a URL, get an audit in 30 seconds (rate-limited)
- Pricing table once bad-app is live
- Customer logos once you have them

### Comparison pages (SEO)
- "bad vs Steel"
- "bad vs Browserbase Stagehand"
- "bad vs browser-use"
- "bad vs Playwright codegen"
- Honest, win-where-you-win

### Templates / starter repos
- "Next.js + bad starter"
- "DeFi dApp testing starter" (with wallet automation)

### Showcase gallery
- Real customer audits (with permission)
- Before/after evolve loop screenshots

**Priority:** P0 (commercial).

---

## Section 10 — What we should NOT build

Resist these:
- Our own LLM provider abstraction (Vercel AI SDK already does this)
- Our own browser engine (patchright is sufficient)
- Our own anti-bot infra from scratch (buy via SteelDriver)
- A mobile app (not a meaningful surface)
- A desktop app for the agent (CLI works, viewer can be web)
- Multi-language SDKs day 1 (TypeScript-only is fine; add Python via REST when bad-app exists)

---

## Surface area summary by priority

### P0 — must do, in rough impact order
1. Session viewer (web app, local + cloud modes)
2. Cursor + element highlight overlays
3. GitHub Action for design audit in PRs
4. Reference library + comparative scoring
5. SteelDriver adapter
6. Documentation overhaul (videos, recipes, troubleshooting)
7. Landing page + demo widget + comparison pages
8. bad-app multi-tenant API + auth + billing
9. Tangle sandbox integration depth
10. CI calibration tests + flaky test fix

### P1 — should do, materially improves the product
11. Time-travel debugging in the viewer
12. Reference-grounded evolve loop
13. Parallel evolve (race agents)
14. Continuous monitoring + regression alerts
15. Audit history (local + cloud)
16. Interactive REPL mode (`bad repl`)
17. TUI for live runs
18. VS Code / Cursor extension
19. Webhook destinations with rich payloads
20. Compliance posture (SOC2 once paying customers)

### P2 — nice to have, polish
21. Cross-project memory / pattern library
22. Custom rubric authoring UI
23. Live preview of CSS evolve overrides
24. Slack / Discord rich notifications
25. Multiple template starters

---

## Implementation tracking

This document is the source of truth. Each item that ships gets a checkmark and a commit/PR reference. Each item in flight gets an `🚧` marker.

Updates land in pursuit specs in `.evolve/pursuits/` for the deeper context, and reflections in `.evolve/reflections/` after each major shipment.
