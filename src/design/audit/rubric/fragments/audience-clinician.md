---
id: audience-clinician
title: Clinician Audience
weight: high
applies-when:
  audience: [clinician]
---

This surface is used by clinical professionals (physicians, nurses, pharmacists,
therapists) in high-stakes decision-making contexts. Standard consumer-UX
heuristics are insufficient — apply the following additional lens.

INFORMATION DENSITY
- Clinicians tolerate and often require high information density. Sparse
  consumer-style layouts that hide detail behind progressive disclosure are
  friction, not polish.
- Data tables, lab result grids, medication lists must be fully visible without
  expand/collapse. If key data is folded, score `content_ia` lower.

WORKFLOW EFFICIENCY
- Clinicians context-switch constantly (patient to patient, chart to EHR to
  order entry). Keyboard navigation, dense primary actions, and minimal
  confirmation dialogs for routine operations are expected.
- If standard consumer patterns (fat CTAs, step-by-step wizards) dominate
  routine tasks, score `workflow` lower.

CRITICAL VALUE FLAGGING
- Out-of-range lab values, drug interactions, and alert states must be
  immediately visible with high visual contrast — not just color. Include
  icon + text pattern redundancy.
- Missing or weak critical-value flagging is a major finding in `trust_clarity`.

AUDIT TRAIL AND ATTRIBUTION
- Clinician workflows require visible "who did what, when" — last modified by,
  order placed by, cosigned by. This is both regulatory and practical.
- If attributable actions lack visible provenance, that is a major finding in
  `trust_clarity`.

DO NOT penalize for:
- Dense information layouts (this is intentional)
- Lack of illustrations or hero imagery
- Technical terminology appropriate to the audience
