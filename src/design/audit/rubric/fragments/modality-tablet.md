---
id: modality-tablet
title: Tablet Modality
weight: low
applies-when:
  modality: [tablet]
---

This surface is evaluated at a tablet viewport (481–1024px wide). Apply this
lens on top of page-type and domain fragments.

LAYOUT ADAPTATION
- The layout must actually adapt between mobile and desktop — not simply
  scale a mobile layout or stretch a desktop layout. A layout that is
  identical to either breakpoint is a minor `visual_craft` finding.

SPLIT-VIEW AND SIDEBAR OPPORTUNITIES
- Tablet viewports often benefit from master-detail or sidebar-content
  patterns rather than single-column stacks. If the content hierarchy would
  benefit from a persistent sidebar and none is present, that is a minor
  `workflow` finding.

TOUCH AND POINTER HYBRID
- Tablet users may use touch or pointer. Touch targets must still meet the
  44pt minimum. Hover-only affordances without touch fallbacks are major
  `workflow` findings.

LANDSCAPE AND PORTRAIT PARITY
- Key interactions must work in both orientations. If a primary action is
  unreachable in landscape (below fold with no scroll), that is a major
  `workflow` finding.

DO NOT penalize for:
- Adapting typography slightly smaller than mobile maximums
- Showing more information density than the mobile equivalent
