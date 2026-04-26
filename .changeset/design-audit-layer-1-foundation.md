---
'@tangle-network/browser-agent-driver': minor
---

feat(design-audit): Layer 1 — multi-dim scoring foundation

Land the first layer of the world-class 8-layer design-audit architecture (RFC `docs/rfc/design-audit-world-class.md`). This release ships:

- **Ensemble classifier** (`src/design/audit/classify-ensemble.ts`) — three-signal vote (URL pattern + DOM heuristic + LLM tiebreaker) with explicit `ensembleConfidence`, `signalsAgreed`, and `dissent` records. URL+DOM agreement above the 0.7 threshold skips the LLM call entirely.
- **Per-page-type rollup weights** (`src/design/audit/rubric/rollup-weights.ts`) — saas-app, marketing, dashboard, docs, ecommerce, social, tool, blog, utility, plus `default`/`unknown` fallbacks. Module-load invariant: every weight set sums to 1.0 ± 1e-6.
- **Per-page-type calibration anchors** (`src/design/audit/rubric/anchors/*.yaml`) — 9 anchor files referencing real product 9-10 examples (Linear's app, Figma, Notion, Stripe, MDN, Apple Store, Threads, Stratechery, Vercel deploys, etc.) so saas-app surfaces are no longer judged against marketing-site polish.
- **Multi-dim scoring** (`src/design/audit/v2/score.ts`) — five universal dimensions (product_intent / visual_craft / trust_clarity / workflow / content_ia) each with `score`, `range`, `confidence`. Rollup is a weighted aggregate with conservative confidence (any dim `low` → rollup `low`).
- **`AuditResult_v2`** — emitted alongside the v1 shape in `report.json` under a top-level `v2` block. One-release deprecation window before v1 is removed.
- **`--audit-passes auto`** — new default that runs the ensemble classifier first, then picks the focused pass bundle for that classification.
- **CLI summary** — per-page console output now prints the 5-dimension breakdown plus rollup formula.

Backwards compat: all existing v1 fields (`score`, `findings`, `summary`, `strengths`, etc.) remain on `PageAuditResult` and `report.json`. Consumers should migrate to `report.v2.pages[].scores` over the next release.

Skill update: `skills/bad/SKILL.md` documents the new JSON shape with an agent-side worked example for choosing which dimension to invest in based on `score × weight` leverage.
