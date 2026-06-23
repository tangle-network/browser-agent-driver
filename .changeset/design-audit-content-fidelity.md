---
'@tangle-network/browser-agent-driver': patch
---

design-audit (reference-grounded): enforce content fidelity so a redesign never fabricates content the page lacks. On a content-sparse page grounded against a dense exemplar, the generator would invent factual content to fill the layout (e.g. a placeholder page gaining a fake "Recent Activity" feed with timestamps, invented status/RFC/registry data), and the pairwise direction-ranker rewarded that invented density as "richer" — so applied to a real app the audit could inject fabricated data into the UI. Now the generator may restyle/regroup/re-rank only the page's real content (the exemplar governs how it looks, never what content it has; a sparse page stays proportionally restrained), the ranker penalises invented content as unfaithful instead of rewarding it, and the apply prompt carries a defense-in-depth "do not invent content" guardrail. No provider coupling.
