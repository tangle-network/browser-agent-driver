---
id: first-principles
title: First-Principles Fallback
weight: critical
applies-when:
  universal: false
---

You haven't seen this pattern before. Do not fabricate a classification.
Audit against the universal product principles only. Score per-dimension as
usual, but set `rollup.confidence = "low"` and emit a top-level
`novel_pattern_signal` describing what you observed, so this surface can be
mined into a new fragment after enough fleet exposure.

1. PRIMARY JOB CLARITY (5 sec test)
   - Within 5 seconds, can a stranger name what this page is for?
   - If no: severity major; finding category `product_intent`.

2. PRIMARY ACTION OBVIOUSNESS
   - Is there one visually-dominant action this page is built around?
   - Are competing actions visually subordinate?
   - If equal-weight: severity major; finding category `product_intent`.

3. STATE PREVIEW
   - Are empty/loading/error states designed, or browser-default / placeholder?
   - Do empty states preview the real product, or show generic illustrations?
   - If generic: severity major; finding category `product_intent`.

4. TRUST BEFORE COMMITMENT
   - Does the page ask the user to commit (money, identity, deploy, share)?
   - If yes: are price, permissions, scope, undo path visible BEFORE the
     commit button?
   - If no: severity critical; finding category `trust_clarity`.

5. RECOVERY FROM FAILURE
   - Can the user undo their last action?
   - Is there a clear path forward when something fails?
   - If no: severity major; finding category `workflow`.

GUARDRAILS:
- Do not invent domain-specific findings ("this dashboard needs charts").
  You don't know the domain. Stick to the five principles.
- Do not anchor on marketing-page heuristics (hero copy, illustrations,
  social proof). They don't apply.
- If a principle simply doesn't apply (e.g. there is no commitment on this
  page), say so explicitly rather than scoring it generically.

RESPOND WITH ONLY a JSON object of the form:
{
  "scores": {
    "product_intent": { "score": <1-10>, "range": [<lo>, <hi>], "confidence": "low", "summary": "<one sentence>", "primaryFindings": [] },
    "visual_craft":   { ... },
    "trust_clarity":  { ... },
    "workflow":       { ... },
    "content_ia":     { ... }
  },
  "rollup": { "score": <1-10>, "range": [<lo>, <hi>], "confidence": "low", "rule": "first-principles", "weights": { "product_intent": 0.30, "workflow": 0.25, "visual_craft": 0.20, "content_ia": 0.15, "trust_clarity": 0.10 } },
  "findings": [ ... ],
  "novel_pattern_signal": {
    "observedSignals": [
      { "label": "<short-label>", "evidence": "<what you saw>", "confidence": <0..1> }
    ]
  },
  "first_principles_mode": true
}
