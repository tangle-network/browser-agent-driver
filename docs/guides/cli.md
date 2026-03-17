# CLI Reference

## Basic Usage

```bash
# single task
bad run --goal "Sign up for account" --url http://localhost:3000

# test suite
bad run --cases ./cases.json

# with config file
bad run --config ./ci.config.ts --cases ./cases.json

# override model/concurrency
bad run --cases ./cases.json --model gpt-5.4 --concurrency 4
```

## Authenticated Sessions

Save a browser session once, reuse across runs:

```bash
pnpm auth:save-state
pnpm auth:check-state ./.auth/session.json example.com
```

```bash
bad run --goal "Open settings" \
  --url https://app.example.com \
  --storage-state ./.auth/session.json
```

## Run Modes

| Mode | Vision | Screenshots | Blocking | Use case |
|------|--------|-------------|----------|----------|
| `fast-explore` | off | off | analytics | Speed / iteration |
| `full-evidence` | on | every 3 turns | — | Release signoff |

Mode presets apply defaults; explicit CLI flags override.

```bash
bad run --cases ./cases.json --mode fast-explore
bad run --cases ./cases.json --mode full-evidence
```

## Execution Profiles

| Profile | Description |
|---------|-------------|
| `default` | Balanced defaults |
| `stealth` | Headed + anti-detection args |
| `webbench` | Speed benchmark (vision off, heavy blocking) |
| `webbench-stealth` | Reach benchmark (stealth args, analytics-only blocking) |
| `webvoyager` | Evidence benchmark (vision on) |

Profiles are orthogonal to modes. Use both:

```bash
bad run --cases ./cases.json --profile webbench-stealth --mode fast-explore
```

## Adaptive Model Routing

Route verification to a cheaper model:

```bash
bad run \
  --model gpt-5.4 \
  --model-adaptive \
  --nav-model gpt-4.1-mini \
  --cases ./cases.json
```

## Trajectory Memory

Memory is enabled by default. Successful run trajectories are stored in `.agent-memory/` and reused on subsequent runs to reduce turns and improve reliability.

```bash
# disable memory for a clean run
bad run --cases ./cases.json --no-memory

# custom memory directory
bad run --cases ./cases.json --memory-dir ./.my-memory

# with trace scoring
bad run --cases ./cases.json --trace-scoring --trace-ttl-days 30
```

## Personas

```bash
# auto-generated from goal + URL
bad run --goal "..." --url https://... --persona auto

# named persona
bad run --goal "..." --url https://... --persona alice-blueprint-builder
```

## Design Audit

LLM-powered design quality audit with domain-specific rubrics:

```bash
bad design-audit --url https://stripe.com
bad design-audit --url https://app.uniswap.org --profile defi
bad design-audit --url http://localhost:3000 --profile saas --pages 10
```

Profiles: `general`, `saas`, `defi`, `marketing`.

### Token Extraction

Pure DOM extraction — no LLM calls. Captures colors, typography, spacing, components, logos, icons, videos, CSS variables, and brand assets at mobile/tablet/desktop viewports. Detects inline libraries (GSAP, Three.js, p5.js, Lottie, Swiper, etc.).

```bash
bad design-audit --url https://stripe.com --extract-tokens
bad design-audit --url https://app.example.com --extract-tokens --json
```

Output: `tokens.json` + downloaded fonts, images, videos, stylesheets, screenshots.

### Site Rip

Download a full working local copy of a website. Uses Playwright network interception to capture every request/response, rewrites HTML/CSS references to local paths.

```bash
bad design-audit --url https://example.com --rip
bad design-audit --url https://example.com --rip --pages 10
```

Reveals hidden content (accordions, tabs, carousels), auto-scrolls for lazy-loaded assets, extracts video URLs from rendered DOM. Output is a self-contained directory that opens in a browser.

### Design Compare

Side-by-side comparison of two URLs with pixel diff and structural token diff.

```bash
bad design-audit --url https://site-a.com --design-compare --compare-url https://site-b.com
```

Captures screenshots at mobile/tablet/desktop viewports. Interacts with the page before capture:
- Expands accordions and `<details>` elements
- Clicks all tabs in tab lists
- Scrolls carousels
- Opens mobile hamburger menus
- Dismisses cookie banners and modals

Output: HTML report with side-by-side screenshots + diff overlay, JSON report with structural token differences (colors, fonts, CSS variables, spacing, brand, components).

## CI Checks

```bash
pnpm lint
pnpm check:boundaries
pnpm test
```
