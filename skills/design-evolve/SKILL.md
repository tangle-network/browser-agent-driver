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

You are a design engineer. Your job is to audit a running app, apply real code fixes to the source, and verify improvement — iterating until the design is measurably better.

## Prerequisites

- `bad` CLI built (`cd ~/webb/browser-agent-driver && pnpm build`)
- Target app running on a local dev server (or deployed URL)
- `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` set
- You must have access to the target project's source code

## Phase 0: Setup

1. Confirm the target URL is accessible (curl or bad)
2. Identify the project root and its CSS/styling approach:
   - Tailwind? → you'll edit `className` props and `tailwind.config`
   - CSS Modules? → edit `.module.css` files
   - Plain CSS? → edit `.css` files
   - styled-components/emotion? → edit style objects
   - Inline styles? → edit component files directly
3. Identify the global stylesheet or layout file (e.g., `globals.css`, `layout.tsx`, `App.tsx`)

## Phase 1: Baseline Audit

Run the initial audit from `~/webb/browser-agent-driver`:

```bash
node dist/cli.js design-audit \
  --url <TARGET_URL> \
  --profile <PROFILE> \
  --pages <N> \
  --json \
  --headless
```

Choose profile based on the app:
- `vibecoded` — AI-generated apps, template-based projects, starter scaffolds
- `saas` — SaaS dashboards, admin panels, productivity tools
- `marketing` — Landing pages, marketing sites
- `defi` — DeFi/crypto apps
- `general` — anything else

Read the full `report.json` output. Note:
- Overall score
- Design system breakdown (8 dimensions)
- Every finding with severity, description, location, cssSelector, cssFix

## Phase 2: Triage Findings

Sort findings by impact:

1. **Critical** — fix first (blocks usage, WCAG failures)
2. **Major** — fix next (unprofessional appearance)
3. **Minor** — fix if time permits (polish details)

Group related findings:
- All spacing issues → one spacing fix pass
- All color/contrast issues → one color fix pass
- All typography issues → one typography fix pass

## Phase 3: Apply Fixes to Source Code

For EACH finding group, apply fixes to the actual source files:

### Tailwind Projects
```tsx
// Finding: "Button border-radius inconsistent — 3 distinct values"
// Fix: Standardize to rounded-lg

// Before
<button className="rounded-md px-4 py-2">  // inconsistent
<button className="rounded-xl px-3 py-1">  // inconsistent

// After
<button className="rounded-lg px-4 py-2">  // consistent
<button className="rounded-lg px-4 py-2">  // consistent
```

### CSS / globals.css
```css
/* Finding: "Body text #6b7280 on #f9fafb fails WCAG AA (3.8:1)" */
/* Fix: Darken to #4b5563 */

/* Before */
.card-text { color: #6b7280; }

/* After */
.card-text { color: #4b5563; }
```

### Key fix categories and what to change:

| Category | What to Fix | Where |
|----------|-------------|-------|
| **spacing** | padding, margin, gap values | Component files, globals.css |
| **typography** | font-size, line-height, letter-spacing, font-weight | Typography tokens, component files |
| **color/contrast** | text color, background color for WCAG compliance | Color tokens, component files |
| **layout** | max-width, grid-template-columns, container padding | Layout components, globals.css |
| **components** | border-radius, box-shadow, border consistency | Component files, design tokens |
| **interactions** | hover/focus/active states, transitions | Component files, globals.css |
| **accessibility** | aria-label, semantic HTML, focus rings | Component JSX/HTML |

### Rules for applying fixes:
- **Match the project's styling approach.** Don't add a CSS file to a Tailwind project.
- **Fix the design system, not individual instances.** If 5 cards have inconsistent radius, fix the shared Card component or the design token, not each card individually.
- **Preserve existing functionality.** Only change visual properties. Never change event handlers, state, or business logic.
- **Batch related fixes.** All spacing fixes in one commit-worthy chunk. All color fixes in another.

## Phase 4: Re-Audit

After applying fixes, re-run the audit:

```bash
node dist/cli.js design-audit \
  --url <TARGET_URL> \
  --profile <PROFILE> \
  --pages <N> \
  --json \
  --headless
```

Compare scores:
- Did the overall score improve?
- Did the design system dimensions improve?
- Are there new findings introduced by the fixes?
- Are the original critical/major findings resolved?

## Phase 5: Iterate

If score improved but gaps remain:
1. Read the new findings
2. Apply the next batch of fixes
3. Re-audit
4. Repeat until:
   - Score improvement < 0.5 between rounds (converged)
   - All critical and major findings are resolved
   - 5 rounds completed (diminishing returns)

If score regressed:
1. Identify which fix caused the regression
2. Revert that specific fix
3. Try an alternative approach
4. Re-audit

## Phase 6: Report

After convergence, summarize:

```
Design Evolve Complete
  Before: 4.5/10 → After: 7.2/10 (+2.7)
  Rounds: 3
  Fixes applied: 14
  
  Dimension improvements:
    spacing:    4 → 7 (+3)
    typography: 5 → 7 (+2)
    color:      6 → 8 (+2)
    components: 4 → 7 (+3)
  
  Remaining issues:
    - 2 minor accessibility findings (need HTML changes)
    - 1 minor interaction finding (need JS changes)
```

## Example Session

User: "improve the design of my app at localhost:3000"

```
1. Run: node dist/cli.js design-audit --url http://localhost:3000 --profile vibecoded --pages 3 --json --headless
2. Read: audit-results/localhost-*/report.json
   Score: 4.2/10
   - 3 critical: contrast failures
   - 8 major: spacing chaos, no type scale, inconsistent radius
   - 12 minor: polish issues

3. Fix round 1 (critical + spacing):
   - Edit globals.css: fix contrast ratios
   - Edit layout.tsx: standardize section gaps to 48px
   - Edit components/Card.tsx: consistent padding and radius

4. Re-audit: Score 5.8/10 (+1.6)
   - Contrast criticals resolved
   - Spacing majors resolved
   - New: typography and component consistency still flagged

5. Fix round 2 (typography + components):
   - Edit tailwind.config.ts: define type scale
   - Edit components/Button.tsx: consistent variants
   - Edit globals.css: heading hierarchy

6. Re-audit: Score 7.1/10 (+1.3)
   - Typography improved
   - Components consistent
   - Remaining: minor polish items

7. Fix round 3 (polish):
   - Add hover/focus states
   - Consistent shadow system
   - Icon sizing

8. Re-audit: Score 7.8/10 (+0.7)
   Converged. Report results.
```

## Multi-Page Strategy

For apps with multiple distinct pages/routes:

1. Audit ALL pages first to find systemic issues (issues appearing on 2+ pages)
2. Fix systemic issues in shared components/styles FIRST
3. Then fix page-specific issues
4. Re-audit all pages together

Systemic fixes (design tokens, shared components) have the highest ROI because they improve every page at once.

## Token Extraction Assist

Before fixing, extract tokens to understand the current design system:

```bash
node dist/cli.js design-audit --url http://localhost:3000 --extract-tokens
```

This reveals:
- How many distinct colors are used (more than 6 non-neutral hues = problem)
- How many font sizes exist (more than 5-6 = no scale)
- What the spacing grid unit is (or isn't)
- How many border-radius values exist (more than 3 = incoherent)

Use this data to inform which design tokens to standardize.
