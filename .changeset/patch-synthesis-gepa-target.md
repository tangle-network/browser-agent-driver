---
'@tangle-network/browser-agent-driver': minor
---

feat(design-audit): add GEPA target for evolving patch synthesis

Adds `patch-synthesis-signature` to the design-audit GEPA harness so the second-call patch generator can be optimized independently from the main audit scoring prompt. The new target mutates structured patch-synthesis instructions, scores variants on patch coverage and validity, and keeps calibration/repro runs configurable for OpenAI-compatible routers via provider/model/base-url options.

Also surfaces design-audit JSON parse failures as measurement errors instead of silently converting unparsable LLM responses into plausible fallback scores.
