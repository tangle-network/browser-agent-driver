---
'@tangle-network/browser-agent-driver': minor
---

feat(design-audit): 8-layer architecture — Layers 1-7 fully shipped, Layer 8 scaffold

Full implementation of RFC-002: World-Class Design Audit. Primary consumer is coding agents (Claude Code, Codex, OpenCode, Pi); the architecture is JSON-first, tool-callable, and self-explaining when uncertain.

**Layer 1 — Multi-dimensional scoring** _(shipped)_
- Ensemble classifier (URL pattern + DOM heuristic + LLM tiebreaker) with `ensembleConfidence`, `signalsAgreed`, `dissent`.
- Five universal dimensions: `product_intent / visual_craft / trust_clarity / workflow / content_ia`.
- Per-page-type rollup weights (saas-app, marketing, dashboard, docs, ecommerce, social, tool, blog, utility).
- Per-page-type calibration anchors (`rubric/anchors/*.yaml`) so app surfaces aren't judged against marketing-site polish.
- `AuditResult_v2` emitted alongside v1 shape; v1 deprecated with one-release lag.

**Layer 2 — Patch primitives** _(shipped)_
- Every major/critical finding now ships `patches[]` with `target`, `diff.before`/`after`, `testThatProves`, `rollback`, `estimatedDelta`, and `estimatedDeltaConfidence`.
- `diff.before` is validated as a substring of the page snapshot at parse time — agents apply patches literally without re-authoring.
- Severity enforcement: findings without valid patches are downgraded from major/critical to minor.
- `patches/render.ts`: renders `unifiedDiff` from before/after when `target.filePath` is known (`git apply`-able).

**Layer 3 — First-principles fallback** _(shipped)_
- Fires when `ensembleConfidence < 0.6`, signals disagree, or page type is `unknown`.
- Scores against 5 universal product principles only (primary-job clarity, action obviousness, state preview, trust-before-commitment, recovery-from-failure).
- Sets `rollup.confidence = 'low'`; emits `NovelPatternObservation` to `~/.bad/novel-patterns/` for fleet mining.
- New rubric fragment `first-principles.md` carries the exact prompt that fires in this mode.

**Layer 4 — Outcome attribution** _(shipped)_
- `bad design-audit ack-patch <patchId> --pre-run-id <runId>` — records that an agent applied a patch.
- `bad design-audit --post-patch <patchId>` on re-audit — computes observed delta vs predicted, writes `agreementScore`.
- JSONL store at `~/.bad/attribution/applications/`. Append-only — outcomes are new events, not mutations.
- `aggregatePatchReliability()` cross-tenant rollup: groups by `patchHash = sha256(before+after+scope).slice(0,16)`. After N≥30 / ≥5 tenants / replicationRate≥0.7 → `recommendation: 'recommended'`.

**Layer 5 — Pattern library** _(scaffold)_
- `patterns/{store,mine,match}.ts` + `cli-patterns.ts` (`bad patterns query|show`).
- Cold-start: library is empty until ~6 weeks of attribution data accumulates. Mine threshold: N≥30, ≥5 tenants, replicationRate≥0.7. Mining impl is a TODO; the query API and types are stable.

**Layer 6 — Composable predicates** _(shipped)_
- `AppliesWhen` extended with `audience`, `modality`, `regulatoryContext`, `audienceVulnerability`.
- 9 new rubric fragments: `audience-{clinician,kids,developer}.md`, `regulatory-{hipaa,gdpr,coppa}.md`, `modality-{mobile,tablet}.md`, `audience-vulnerability-minor-facing.md`.
- Rubric loader matches new predicates when context provided via `--audience`, `--modality`, `--regulatory`, `--audience-vulnerability` CLI flags.

**Layer 7 — Domain ethics gate** _(shipped)_
- 4 rule files (medical, kids, finance, legal) with citation-backed rules (FDA 21 CFR 201.57, COPPA 16 CFR 312.5, TILA/Reg Z, GDPR).
- Hard rollup floor: `critical-floor → 4`, `major-floor → 6`. `preEthicsScore` preserves the LLM's uncapped score.
- `--skip-ethics` bypass (test-only, logged + warned), `--ethics-rules-dir` override.
- 8 paired pass/fail fixtures in `bench/design/ethics-fixtures/`.

**Layer 8 — Modality adapters** _(scaffold)_
- `modality/{types,html,ios,android,index}.ts`. HTML adapter wraps existing Playwright pipeline. iOS and Android throw `NotImplementedError` with clear message. `--modality html|ios|android` dispatches to the right adapter.

**Skill contract updates:**
- `~/code/dotfiles/claude/skills/bad/SKILL.md`: patch consumption loop, Layer 3-8 contract, ack-patch / --post-patch close-the-loop, ethics floor priority rule.
- `skills/design-evolve/SKILL.md`: Phase 3 (apply fixes) now patch-first; Phase 4 includes attribution close-the-loop.

**Tests:** +40 new tests across `design-audit-patch-{parse,validate}`, `design-audit-first-principles`, `design-audit-attribution`. Total: 1393 passing.
