---
id: regulatory-coppa
title: COPPA Regulatory Context
weight: critical
applies-when:
  regulatoryContext: [coppa]
---

This surface is subject to COPPA (Children's Online Privacy Protection Act).
Apply this lens when the audience includes or may include users under 13. The
ethics gate (Layer 7) independently enforces hard score floors for missing
age gates and dark patterns — both apply simultaneously.

VERIFIABLE PARENTAL CONSENT
- If this surface collects personal data from users who may be under 13,
  a verifiable parental consent mechanism must be visible and functional.
  Absent: critical finding in `trust_clarity`.

AGE GATE INTEGRITY
- Age gates must require date-of-birth entry, not a single yes/no question
  ("Are you 13 or older?"). A single-question age gate is a major finding —
  it is trivially bypassed.

DATA COLLECTION DISCLOSURE
- A clear, plain-English summary of what data is collected and why must be
  visible before any data collection begins. Buried in a privacy policy does
  not satisfy this requirement. Absent: major finding in `content_ia`.

PROHIBITION ON BEHAVIORAL TARGETING
- No behavioral advertising or cross-site tracking may be enabled for users
  under 13. If third-party tracking scripts are present without age-based
  gating: critical finding in `trust_clarity`.
