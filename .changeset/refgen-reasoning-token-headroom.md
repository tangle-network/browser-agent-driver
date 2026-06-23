---
'@tangle-network/browser-agent-driver': patch
---

design-audit (reference-grounded): make redesign generation work with reasoning models. The generator capped output at 2200 tokens, which a reasoning model (e.g. GLM-5.2, o-series) spends on its thinking before the answer — so the JSON direction came back empty or truncated and the audit fell back with a misleading "no JSON object found". Raise the per-direction budget to 8000 (non-reasoning models stop at the closing brace and never use the extra, so it's free for them), and report empty vs truncated vs non-JSON output distinctly so a budget/limit issue is diagnosable. No coupling to any one provider — the engine already runs on openai/anthropic/google/claude-code/zai.
