# Evolve Progress — Design Audit

Branch: `design-audit-gen2` (carries both Gen 2 and Gen 3 changes)

## Generation 3 — 2026-04-06

Pursuit: `.evolve/pursuits/2026-04-06-design-audit-gen3.md`

### Shipped
1. ROI scoring on findings — impact, effort, blast, computed roi
2. Cross-page systemic detection — findings on 2+ pages collapse into 1 with blast=system
3. CDP-based axe injection (3-tier fallback for CSP-strict pages)
4. Dynamic per-fragment dimensions — fragments declare custom dimensions, LLM scores them
5. Top Fixes report section — opens every report with ROI-sorted top 5
6. JSON output exposes `topFixes`
7. 28 new unit tests (24 ROI + 4 dimensions)

### Calibration (3 generations)
| Site | Gen 1 | Gen 2 | Gen 3 |
|------|-------|-------|-------|
| Stripe | 9 | 9 | 9 |
| Apple | 9 | 9 | 9 |
| Linear | 9 | 9 | 9 |
| Anthropic | 8 | 8 | 8 |
| Airbnb | 8 | 8 | 8 |

5/5 preserved across all 3 generations. Gen 3 adds top-fixes ROI ranking,
dynamic dimensions (Stripe gets `trust-signals`, Airbnb gets `conversion`),
and live cross-page systemic detection (verified on 3-page Stripe audit).

### Architecture additions (Gen 3)
- `src/design/audit/roi.ts` — pure-function ROI scoring + cross-page detection (167 lines)
- `tests/design-audit-roi.test.ts` — 24 unit tests
- Extended `RubricFragment.dimension`, `ComposedRubric.dimensions`
- Extended `DesignFinding` with impact/effort/blast/roi/pageCount
- Extended `measure/a11y.ts` with CSP-bypass injection ladder

### Next generation seeds (Gen 4)
- 3-turn pipeline (separate ranking call)
- Reference library with embedded fingerprints
- Live evolve loop validation against a real vibecoded app
