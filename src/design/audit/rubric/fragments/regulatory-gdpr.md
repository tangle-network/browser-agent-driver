---
id: regulatory-gdpr
title: GDPR Regulatory Context
weight: high
applies-when:
  regulatoryContext: [gdpr]
---

This surface is subject to GDPR. Apply the following lens in addition to other
applicable fragments. Note: the ethics gate (Layer 7) independently enforces a
score floor for missing consent mechanisms — both apply.

CONSENT MECHANISM QUALITY
- Cookie consent banners must offer granular controls (necessary / analytics /
  marketing) with equal visual prominence. An "Accept all" button that is
  larger or more prominent than "Manage preferences" is a major `trust_clarity`
  finding.
- Pre-ticked checkboxes are a critical finding — they are unlawful under GDPR.

DATA SUBJECT RIGHTS ACCESS
- Users must be able to find their data rights (access, deletion, portability,
  correction) without more than 2 navigation steps from any page. If the
  privacy page is not reachable from the footer, that is a major finding in
  `content_ia`.

LEGAL BASIS TRANSPARENCY
- If the page collects personal data, the legal basis (consent, legitimate
  interest, contract) must be stated. Absent: minor finding in `trust_clarity`.

DATA RETENTION
- If retention periods are disclosed (they should be), they must be
  understandable to a non-lawyer. Legal boilerplate with no plain-English
  summary is a minor finding in `content_ia`.
