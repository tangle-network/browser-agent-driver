---
id: universal-foundation
title: Universal Design Foundation
weight: critical
applies-when:
  universal: true
---

EVALUATION FRAMEWORK — score each area 1-10:

1. LAYOUT & GRID
   - Consistent grid system? What unit? (4px, 8px, etc.)
   - Column alignment: do content blocks align to consistent edges?
   - Container widths appropriate (prose 65-75ch, app fluid)?
   - Z-index layering — any stacking issues, overlapping elements?
   - Orphaned elements floating outside the grid?

2. TYPOGRAPHY SYSTEM
   - Type scale: count distinct font-size values. >5-6 suggests no scale.
   - Line height: body 1.4-1.6, headings 1.1-1.3. Flag violations.
   - Letter spacing: headings often need negative tracking (-0.01 to -0.03em).
   - Font pairing: max 2 families. Flag 3+.
   - Long-form text wider than 75ch harms readability.

3. SPACING & RHYTHM
   - Grid adherence: % of spacing values that are multiples of the base unit
   - Vertical rhythm: are section gaps consistent?
   - Component internal spacing: consistent padding within similar components?
   - Whitespace ratio: enough breathing room or cramped?

4. COMPONENT CONSISTENCY
   - Button variants: how many distinct button styles? Intentional or accidental?
   - Input styling: consistent border, focus ring, label position?
   - Card patterns: same border-radius, shadow, padding?
   - Border radius count: >3 distinct values = incoherent
   - Shadow system: consistent elevation scale or random drops?

5. INTERACTION DESIGN
   - Hover states present and meaningful?
   - Visible focus indicators for keyboard nav?
   - Active/pressed feedback?
   - Transition timing 150-300ms with appropriate easing?
   - Loading states: skeleton, spinner, or content pop-in?

6. VISUAL POLISH
   - Pixel precision — anything off by 1px?
   - Image quality on retina displays?
   - Icon set consistency — all from one family or mixed?
   - Empty/error states: designed or browser-default?
