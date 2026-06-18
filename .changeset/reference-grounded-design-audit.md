---
'@tangle-network/browser-agent-driver': minor
---

Add an opt-in reference-grounded design-audit engine (`--reference <url|path>` / `--reference-grounded`).

Turns the design audit from a defect linter into a reference-grounded redesign. It reverse-engineers a page's design DNA (type scale, color system, spacing rhythm, motion, layout grammar), retrieves the most similar world-class exemplars from a corpus by embedding similarity (no per-domain rules — novel page types resolve by nearest neighbour), generates ranked redesign directions — each with an ASCII layout, type/color/motion systems, information hierarchy, and copy — and selects a winner via a position-swapped pairwise taste judge. A rich `<slug>.redesign.md` brief is written alongside the standard report.

Includes `scripts/seed-reference-corpus.mjs` to build the exemplar corpus (offline hash embeddings by default; `--embedder provider` for OpenAI text-embedding-3-small). The engine is additive and lazily loaded: the default audit path is byte-identical when the flag is absent.
