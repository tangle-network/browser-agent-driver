---
'@tangle-network/browser-agent-driver': minor
---

design-audit (reference-grounded): make the redesign engine job-first instead of aesthetic-first. The old engine grounded every page in a world-class exemplar's visual DNA and judged on visual craft, so it regressed functional pages into generic brochures — a docs page lost its table-of-contents and dense reference content for two marketing cards and a hero; an aggregator dropped from 30 items to 9; a status dashboard shed services into spacious cards. The fix:

- **Generator** (`reference/generate/prompt.ts`): persona reframed from art director to product designer. New hard rules in priority order — task-first (design for the page's users and the job in its intent) → preserve functional affordances (never delete navigation/ToC/search to look cleaner) → preserve density where it is the value (docs/dashboards/feeds keep their item count) → right-size the intervention (never turn one kind of page into another) → the exemplar is a source of visual craft only, never a structural template.
- **Functional contract**: a per-page preservation block derived from the page's own measured DNA (navigation-affordance count, layout density, archetype) so "keep what works" is concrete and data-driven, not exhortation — and density is required only when the page is actually measured dense, so a genuinely sparse page is never forced to stay dense.
- **Ranker/judge** (`reference/judge/prompt.ts`): scores task fitness and functional preservation BEFORE visual craft; a polished direction that removes navigation or reduces density loses. "Fit to the reference" counts only as visual craft.

Validated by re-running the regressed pages: docs now keeps its ToC + prev/next nav + dense code examples; HN keeps all 30 stories + nav; the status dashboard stays a dense service grid with real values. No provider coupling; flag-gated reference engine only.
