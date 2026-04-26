---
id: regulatory-hipaa
title: HIPAA Regulatory Context
weight: high
applies-when:
  regulatoryContext: [hipaa]
---

This surface handles Protected Health Information (PHI) and is subject to HIPAA
technical safeguards. Apply this lens in addition to domain-specific fragments.

SESSION SECURITY VISIBILITY
- Automatic session timeout must be visible to the user (countdown or clear
  logout trigger). Invisible timeout with hard logout is a major `workflow`
  finding.
- If the surface shows PHI and has no visible session indicator, that is a
  major `trust_clarity` finding.

MINIMUM NECESSARY DATA
- Only the minimum necessary PHI should be visible on any given screen.
  Dashboards that show full SSN, full DOB, or complete medication histories
  when partial identifiers suffice are major `trust_clarity` findings.

AUDIT LOG ACCESS
- If this surface allows modification of PHI, a visible "audit log" or
  "activity history" link must be accessible to the user. Absent: minor
  finding in `trust_clarity`.

DATA EXPORT LABELING
- Export buttons (CSV, PDF, print) must label the output as PHI with a
  handling reminder. Unlabeled PHI export is a minor finding.

DO NOT penalize for:
- Explicit data masking that adds cognitive load (masks protect PHI)
- Confirmation dialogs on irreversible PHI operations
- Conservative color coding that prioritizes legibility over aesthetics
