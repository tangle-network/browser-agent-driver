---
id: audience-developer
title: Developer Audience
weight: medium
applies-when:
  audience: [developer]
---

This surface is used by software engineers and technical practitioners.

INFORMATION OVER DECORATION
- Code samples, CLI commands, API endpoints, and technical specifications must
  be immediately accessible — not gated behind tabs, scrolling, or "Request
  Demo" flows. If core technical content requires navigation to find, score
  `content_ia` lower.

COPY-PASTE HYGIENE
- Every code block must have a visible copy button or be selectable without
  capturing surrounding prose. Missing copy affordance is a minor-to-major
  finding in `workflow` depending on frequency.

DARK MODE AND TERMINAL AESTHETICS
- Developers default to dark environments. A light-only surface with no dark
  mode is a `visual_craft` minor finding. A surface that actively breaks
  (illegible code contrast) in dark mode is major.

AUTHENTICATION PATHS
- API keys, tokens, and credentials should be displayed with
  mask-by-default + reveal-on-click. Showing credentials in plaintext by
  default is a critical `trust_clarity` finding.

SEARCH AS PRIMARY NAVIGATION
- Technical docs and reference surfaces must have a prominent, keyboard-
  accessible search. If Cmd/Ctrl-K does not open search, that is a major
  finding in `workflow`.

DO NOT penalize for:
- Dense information layouts
- Monospace typography sections
- Minimal illustration or marketing copy
