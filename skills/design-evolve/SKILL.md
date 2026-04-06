---
name: design-evolve
description: >-
  Closed-loop design improvement using bad design-audit. Audits a running app,
  reads findings, applies fixes to actual source code, re-audits to verify
  improvement, iterates until converged. Use when the user says 'improve the
  design', 'design audit and fix', 'evolve the design', 'make this look
  better', 'polish the UI', or wants automated design improvement on a running
  app.
---

# design-evolve — Closed-Loop Design Improvement

You are a design engineer. Audit a running app, apply real code fixes to the source, verify improvement — iterate until measurably better.

## Prerequisites

- `bad` CLI built (`cd ~/webb/browser-agent-driver && pnpm build`)
- Target app running on a local dev server (or deployed URL)
- Access to the target project's source code

No API key needed — defaults to `claude-code` provider (uses your Claude Code subscription).

## Phase 0: Setup

1. Confirm the target URL is accessible
2. Identify the project root and its styling approach:
   - Tailwind → edit `className` props and `tailwind.config`
   - CSS Modules → edit `.module.css` files
   - Plain CSS → edit `.css` files
   - styled-components/emotion → edit style objects
3. Identify the global stylesheet or layout file (`globals.css`, `layout.tsx`, `App.tsx`)

## Phase 1: Baseline Audit

```bash
node dist/cli.js design-audit \
  --url <TARGET_URL> \
  --profile <PROFILE> \
  --pages <N> \
  --json --headless
```

Profile is optional — the audit auto-classifies the page (type, domain, framework, design system, maturity). Pass `--profile <name>` only to override.

Read the `report.json`. The audit pre-ranks the work — focus on these fields:

- **`topFixes`** — array of the 5 highest-ROI fixes across all audited pages, pre-sorted. Each has `roi`, `impact`, `effort`, `blast`, plus the usual `description` / `cssSelector` / `cssFix`. **Start here.**
- **`pages[].score`** — overall visual quality score per page (1-10, LLM-judged)
- **`pages[].designSystemScore`** — 8 universal dimensions plus any custom dimensions contributed by the rubric (e.g. `trust-signals` for fintech, `conversion` for ecommerce, `readability` for docs). Accessibility dimension reflects ground-truth measurements (axe + WCAG contrast math), not LLM vibes.
- **`pages[].classification`** — what the audit thinks this page is. Useful context.
- **`pages[].findings`** — full finding list with `roi` annotations. Anything beyond the top 5 is lower priority.

## Phase 2: Triage from Top Fixes

The audit already ranked the work. Don't re-prioritize from scratch:

1. Start with `topFixes[0]` and work down
2. `blast: 'system'` = a single fix improves every page — highest leverage, do these first
3. `pageCount >= 2` = the audit detected the same issue across multiple pages (`[appears on N pages]`) — fix once, all benefit
4. Don't waste time on findings ranked below `topFixes[5]` unless you have time after the headline fixes
5. Sanity-check ROI: high `impact × blast / effort` should genuinely match what would help most

Batch related fixes: all spacing in one pass, all color in another.

## Phase 3: Apply Fixes to Source Code

Match the project's styling approach. Fix the **design system** (shared components, tokens, globals), not individual instances.

**Tailwind:**
```tsx
// Before — inconsistent
<button className="rounded-md px-4 py-2">
<button className="rounded-xl px-3 py-1">

// After — consistent
<button className="rounded-lg px-4 py-2">
<button className="rounded-lg px-4 py-2">
```

**CSS:**
```css
/* Finding: "Body text #6b7280 on #f9fafb fails WCAG AA (3.8:1)" */
/* Before */ .card-text { color: #6b7280; }
/* After */  .card-text { color: #4b5563; }
```

| Category | What to Fix | Where |
|----------|-------------|-------|
| spacing | padding, margin, gap | Component files, globals.css |
| typography | font-size, line-height, letter-spacing | Typography tokens, components |
| color/contrast | text color, bg color for WCAG | Color tokens, components |
| layout | max-width, grid-template-columns | Layout components, globals |
| components | border-radius, box-shadow, border | Component files, design tokens |
| interactions | hover/focus/active states, transitions | Component files, globals |
| accessibility | aria-label, semantic HTML, focus rings | Component JSX/HTML |

Rules:
- Match the project's styling approach — don't add CSS files to a Tailwind project
- Fix the design system, not individual instances
- Only change visual properties — never touch event handlers, state, or business logic

## Phase 4: Re-Audit

```bash
node dist/cli.js design-audit \
  --url <TARGET_URL> \
  --profile <PROFILE> \
  --pages <N> \
  --json --headless
```

Compare: did score improve? Are original critical/major findings resolved? Any new findings introduced?

## Phase 5: Iterate

Repeat until:
- Score improvement < 0.5 between rounds (converged)
- All critical and major findings resolved
- 5 rounds completed

If score regressed: identify which fix caused it, revert, try alternative, re-audit.

## Phase 6: Report

```
Design Evolve Complete
  Before: 4.5/10 → After: 7.2/10 (+2.7)
  Rounds: 3, Fixes applied: 14
  
  Dimension improvements:
    spacing: 4→7  typography: 5→7  color: 6→8  components: 4→7
  
  Remaining: 2 minor accessibility (need HTML), 1 minor interaction (need JS)
```

## Token Extraction Assist

Before fixing, extract tokens to understand the current design system:

```bash
node dist/cli.js design-audit --url http://localhost:3000 --extract-tokens
```

Reveals: distinct color count (>6 hues = problem), font size count (>5-6 = no scale), spacing grid unit, border-radius count (>3 = incoherent).

## Multi-Page Strategy

1. Audit ALL pages first to find systemic issues (appearing on 2+ pages)
2. Fix systemic issues in shared components/styles FIRST
3. Then fix page-specific issues
4. Re-audit all pages together
