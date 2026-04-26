---
id: modality-mobile
title: Mobile Modality
weight: medium
applies-when:
  modality: [mobile]
---

This surface is evaluated at a mobile viewport (≤480px wide). Apply the
following lens on top of page-type and domain fragments.

TOUCH TARGET SIZING
- Interactive elements must meet minimum 44×44pt touch targets (WCAG 2.5.5
  AAA; Apple HIG minimum). Anything below 32pt is a major finding in
  `workflow`. Count the number of undersized targets — if >3 on a single
  screen, escalate to critical.

THUMB-ZONE REACHABILITY
- Primary actions must be reachable in the bottom 60% of a 375px screen
  one-handed. A primary CTA pinned to the top of the viewport is a major
  `workflow` finding.

HORIZONTAL SCROLL AVOIDANCE
- Content must not require horizontal scroll on a 375px viewport. Tables
  that overflow without a scroll affordance are major `workflow` findings.

FONT LEGIBILITY
- Body text must be ≥16px (browser zoom notwithstanding). Text smaller than
  14px is a major `visual_craft` finding. Text below 12px is critical.

FORM INPUT KEYBOARD
- Input fields must trigger the appropriate virtual keyboard type (numeric
  for phone/postcode, email for email, tel for phone numbers). Wrong keyboard
  type is a minor `workflow` finding per field.

DO NOT penalize for:
- Navigation patterns specific to mobile (hamburger, bottom tab bar)
- Reduced visible surface area compared to desktop
- Single-column layouts
