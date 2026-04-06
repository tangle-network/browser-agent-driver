# Evolve Progress — Design Audit

## Generation 2 — 2026-04-06 (branch: design-audit-gen2)

Pursuit: `.evolve/pursuits/2026-04-06-design-audit-gen2.md`

### Shipped
1. Module split — 7 focused modules under `src/design/audit/`
2. Page classifier — auto-detects type/domain/framework/designSystem/maturity/intent
3. Composable rubric system — 12 markdown fragments, no hardcoded profiles
4. Real WCAG contrast math — pure JS, in-page, deterministic (replaces LLM estimates)
5. axe-core integration — ground-truth a11y violations
6. Composing evaluator — measurements-first, LLM only for subjective visual layer
7. CLI integration — Gen 2 default, Gen 1 fallback via `--gen 1`
8. 27 new unit tests
9. Build script copies markdown fragments to dist/

### Calibration
| Site | Gen 1 | Gen 2 | A11y dim |
|------|-------|-------|----------|
| Stripe | 9 | 9 | 8 |
| Apple | 9 | 9 | 4 |
| Linear | 9 | 9 | 4 |
| Anthropic | 8 | 8 | 7 |
| Airbnb | 8 | 8 | 8 |

5/5 preserved within ±0. A11y dimension exposes real measurement truth.

### Architecture (Gen 2)
- `src/design/audit/types.ts` — all audit types (203 lines)
- `src/design/audit/classify.ts` — page classifier (165 lines)
- `src/design/audit/rubric/loader.ts` — fragment loader + composer (240 lines)
- `src/design/audit/rubric/fragments/*.md` — 12 markdown rubrics
- `src/design/audit/measure/contrast.ts` — WCAG 2.1 contrast math (222 lines)
- `src/design/audit/measure/a11y.ts` — axe-core wrapper (143 lines)
- `src/design/audit/measure/index.ts` — gathers all measurements in parallel (46 lines)
- `src/design/audit/evaluate.ts` — composes everything into findings (294 lines)
- `src/design/audit/pipeline.ts` — orchestrator (137 lines)
- `tests/design-audit-rubric.test.ts` — 18 unit tests
- `tests/design-audit-measurements.test.ts` — 9 unit tests

### Next generation seeds
- Reference library with embedded comparison
- 3-turn audit (classify → analyze → rank)
- ROI-sorted findings
- CDP-based axe injection (CSP-strict pages)
- Per-fragment dimension scoring
