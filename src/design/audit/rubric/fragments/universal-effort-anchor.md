---
id: universal-effort-anchor
title: Effort & ROI Calibration
weight: critical
applies-when:
  universal: true
---

EFFORT SCALE — when scoring `effort` on a finding, use these anchors:

| Effort | Definition | Examples |
|---|---|---|
| 1 | Single CSS value change in a token or shared style | `--color-text: #4b5563`, `padding-bottom: 48px` |
| 2 | Single component file edit | Update `Button.tsx` to add focus ring |
| 3 | A few related component edits | Standardize 3 card components to one radius |
| 4 | New design token + propagation | Add `--space-section`, replace 12 hardcoded values |
| 5 | New shared component | Build a reusable `Stack` to fix layout drift |
| 6 | Significant component refactor | Restructure `Sidebar` to support responsive collapse |
| 7 | Section redesign | Hero rewrite with new copy hierarchy |
| 8 | Multi-page layout change | Apply new grid container across routes |
| 9 | Design system overhaul | New type scale + recolor + spacing rebuild |
| 10 | Full app redesign | Greenfield rebuild |

IMPACT SCALE — when scoring `impact` on a finding:

| Impact | Definition |
|---|---|
| 1-2 | Pure nitpick. Most users wouldn't notice. |
| 3-4 | Visible if you're looking. Polish detail. |
| 5-6 | Noticeable on first scan. Affects perceived quality. |
| 7-8 | Hurts trust or usability. Affects task success. |
| 9-10 | Breaks the experience. WCAG failures, broken layouts, unreadable text. |

BLAST SCALE — when assigning `blast`:

| Blast | When |
|---|---|
| `page` | Only this page benefits from the fix |
| `section` | A region of this page (hero, footer, sidebar) |
| `component` | A shared component (`Card`, `Button`) — multiple pages benefit |
| `system` | A design token, global style, or universal pattern — every page benefits |

RANKING DISCIPLINE — assign these honestly:
- A 5-second token change with system blast (e.g. fix the body text gray) should DOMINATE a 2-day visual polish refactor.
- Don't inflate impact to make minor findings sound important. The user fixes the top-5; everything below 5 may never get touched.
- A "small but everywhere" fix beats a "big but isolated" fix in ROI ranking — that's correct.
