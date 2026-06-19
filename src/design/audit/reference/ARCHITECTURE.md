# Reference-Grounded Art Director — Build Spec

**Engine root:** `src/design/audit/reference/`
**Status:** additive, flag-gated. Default audit behaviour is byte-identical to today.
**Contracts:** every type/interface named below lives in [`contracts.ts`](./contracts.ts) — the single, logic-free source of truth.

---

## 0. What this is

Today `bad design-audit` is a defect-and-patch linter: it emits `DesignFinding[]` + CSS patches, judges referencelessly against prose anchors, and de-hardcodes nothing (four scattered if/else domain tables: `inferAuditMode` regex, `DEFAULT_DEEP_PASSES_BY_TYPE`, `profileToFragmentIds`, `domain-*.md` fragments).

This engine adds a **reference-grounded** path: it turns a page into a structured `DesignDNA`, retrieves *k* world-class `Exemplar`s by nearest-neighbour (not by domain table), generates 2-3 **named `RedesignDirection`s** grounded in those exemplars, and picks a winner with a **position-debiased pairwise taste judge** + Bradley-Terry/Elo rollup. The headline 0-10 score comes from an **absolute quality leg** (current page vs exemplars), giving the pipeline a single honest scoring authority.

It is reached only via `--reference` / `evalMode: 'reference-grounded'`. With the flag absent, not one byte of the v1 prompt or output changes.

### Synthesis provenance

This is the best-of-breed of the three panel designs:

- **Skeleton = Design 3** (highest score, 8.3): the `src/design/audit/reference/` layout with the pure-core/IO-adapter split per stage and a `contracts.ts` hub.
- **Grafted from Design 2:** the injected `JudgeBackend`/`TasteJudge` boundary, the deterministic hash embedder as the offline default, and the streaming concurrent generator.
- **Grafted from Design 1:** the explicit fail-closed `guard`, the `seedExemplar`/reverse-engineer corpus authoring path, and the "headline score is its own pure core" discipline.

Every god-object risk and leaky abstraction the reviewers raised is resolved below (§9).

---

## 1. Module list

Layer tags (`L0`…`L5`) are the DAG levels proved acyclic in §3. **PURE** = no IO/LLM/browser, unit-testable on fixtures alone. **ADAPTER** = thin IO/LLM/browser boundary implementing one contract interface. **ORCH** = wiring only, zero domain logic.

### L0 — Contracts

| Path | Kind | Responsibility |
|---|---|---|
| `contracts.ts` | types | Single source of truth for every shared type + the 8 boundary interfaces (corpus access is split into `CorpusReader` + `CorpusWriter`). Zero runtime, zero consts. |

### L1 — Pure cores (`import` only `contracts` + existing reused symbols)

| Path | Kind | Public API | Responsibility |
|---|---|---|---|
| `config.ts` | PURE | `DEFAULT_REFERENCE_CONFIG: ReferenceGroundedConfig`, `DEFAULT_RETRIEVE_WEIGHTS: RetrieveWeights`, `resolveReferenceConfig(partial?): ReferenceGroundedConfig` | Frozen defaults + clamped merge of operator overrides (k, directionCount, budget). |
| `dna/derive.ts` | PURE | `toDesignDNA(tokens: DesignTokens, measurements?: MeasurementBundle): DesignDNA`, `summarizeDNA(dna: DesignDNA, opts?: { maxChars?: number }): string` | Fold a `DesignTokens` (+ measurements) into a normalised `DesignDNA`; budget-bounded prompt summary. Reads `ColorToken.cluster` + `ViewportTokens.gridBaseUnit` — never re-clusters. |
| `dna/delta.ts` | PURE | `dnaDelta(current: DesignDNA, target: DesignDNA): DnaDelta` | Structural delta **at DNA altitude only** (color roles, type scale, spacing, components). Does NOT diff raw tokens. |
| `dna/descriptor.ts` | PURE | `aestheticDescriptor(dna: DesignDNA): string`, `structuralFeatures(dna: DesignDNA): number[]` | Derive the text the embedder embeds + a deterministic fixed-length structural vector. |
| `retrieval/embedding-hash.ts` | PURE | `HashEmbeddingProvider: EmbeddingProvider`, `cosineSimilarity(a, b): number` | Deterministic hash embedder (offline/test default) + `cosineSimilarity`. **Literally pure** — no network, no dynamic import. `retrieval/matcher` imports only `cosineSimilarity` from here, so the L1→L1 edge stays inside the pure subgraph. |
| `retrieval/matcher.ts` | PURE | `retrieve(query: CorpusQuery, corpus: Exemplar[], weights?: RetrieveWeights): RetrievalResult[]`, `scoreExemplar(query, e, weights?): number` | **The de-hardcoding core.** Hard-filter by `pageType`, rank by `cosineSimilarity` over aesthetic vectors blended with structural + (low-weight) job overlap. Novel page types resolve to the nearest neighbour. Consumes a pre-computed `query.aestheticVector` — never embeds. |
| `corpus/schema.ts` | PURE | `parseExemplar(raw: unknown): Exemplar`, `isExemplar(raw): raw is Exemplar`, `serializeExemplar(e): string` | Validate/(de)serialise one `Exemplar`; reject malformed rows. Treats other-org corpus rows as data (no eval, no prototype pollution). |
| `generate/prompt.ts` | PURE | `buildDirectionPrompt(ctx: GenerationContext, exemplar: RetrievalResult, opts?): { system: string; user: string }` | Deterministic prompt grounding ONE exemplar's DNA/id into a single-direction request. Byte-stable for fixed inputs; bounds injected DNA to protect the token budget. |
| `generate/parse.ts` | PURE | `parseDirection(raw: string, allowedIds: string[]): DirectionParseResult`, `validateGrounding(d: RedesignDirection, allowedIds: string[]): string[]` | Parse model JSON → `RedesignDirection`; reject ungrounded exemplar ids; fenced-JSON tolerant; fail-closed (typed error, never a fabricated direction). |
| `judge/prompt.ts` | PURE | `buildPairwisePrompt(input: JudgePairInput, slot: 'AB' \| 'BA'): { system: string; user: string }`, `buildQualityPrompt(input: JudgePairInput, slot): { system: string; user: string }` | Deterministic reference-grounded pairwise + page-vs-exemplar prompts with explicit anti-position-bias instructions. |
| `judge/parse.ts` | PURE | `parseRawVerdict(raw: string): RawVerdict` | Parse a judge response into a slot-relative `RawVerdict`; fail-closed to a `tie` with reason on garbage. |
| `judge/pairwise.ts` | PURE¹ | `judgePair(judge: TasteJudge, input: JudgePairInput, reps?: number): Promise<TasteVerdict>`, `reconcileVerdicts(ab: RawVerdict, ba: RawVerdict, aId, bId): TasteVerdict` | Position-swapped double-run debias: run both slot orders through the **injected** `TasteJudge`, reconcile to an id-keyed `TasteVerdict` (disagreement → tie). `reconcileVerdicts` is fully pure. |
| `judge/quality.ts` | PURE¹ | `assessPageQuality(judge: TasteJudge, page: JudgeSubject, exemplars: JudgeSubject[], opts?: { dimensions?: Dimension[] }): Promise<QualityAssessment>` | The **absolute** leg: page vs top exemplars, position-swapped → `overallWinRate`. When `opts.dimensions` is set it issues one **dimension-scoped** comparison set per `Dimension` (passing `JudgePairInput.dimension`) and buckets each `RawVerdict.dimension` into a per-dim win-rate, so `dimensionWinRates` is genuinely judge-resolved — never `overallWinRate` stamped across dims. Omitted ⇒ `dimensionWinRates` is left undefined. |
| `judge/rank.ts` | PURE | `rankDirections(ids: string[], verdicts: TasteVerdict[]): RankResult`, `bradleyTerry(verdicts): Record<string,number>`, `updateElo(ra, rb, outcome, k?): [number, number]`, `calibrateAgainstVotes(verdicts: TasteVerdict[], votes: HumanVote[]): CalibrationResult` | Bradley-Terry/Elo rollup → `RankResult`; human-vote calibration hook. Satisfies `DirectionRanker`. |
| `engine/budget.ts` | PURE | `planJudgeBudget(directionCount: number, k: number, budget: EngineBudget, dimensions?: number): { directionPairs; qualityPairs; reps; qualityDimensions }`, `mapWithConcurrency<T,R>(items: T[], n: number, fn): Promise<R[]>` | Cost planning + bounded-concurrency map. The ONLY home for concurrency/budget math — keeps adapters and the core thin. `qualityPairs` accounts for the per-`Dimension` expansion (`k × dimensions`); `qualityDimensions` is the dim set the budget can actually afford (0 ⇒ overall-only, no fabricated per-dim scores). |
| `engine/guard.ts` | PURE | `decideProceed(input: { corpusSize: number; retrieved: number; reference?: ReferenceContext }): { ok: true } \| { ok: false; reason: string }` | Fail-closed decision: no exemplars and no reference → explicit abort reason (never a default-looking run mislabelled reference-grounded). |
| `engine/score-core.ts` | PURE | `deriveHeadlineScore(quality: QualityAssessment, measurements: MeasurementBundle): number`, `toDimensionScores(quality: QualityAssessment): Record<Dimension, DimensionScore>`, `toDesignSystemScore(quality: QualityAssessment): DesignSystemScore` | **The single scoring authority.** `deriveHeadlineScore` maps win-rate → 0-10 with a measurement floor. `toDimensionScores` maps the per-`Dimension` `dimensionWinRates` → the rich 5-dim `Record<Dimension, DimensionScore>` that **is** stage-8's `precomputedScores` hook (win-rate → 1-10 score; `comparisons` → `range`/`confidence`); a dim with no win-rate is filled at `confidence:'low'` with an explicit summary, never silently faked. `toDesignSystemScore` projects `overallWinRate` onto the flat 8-dim `DesignSystemScore` for the `PageAuditResult.designSystemScore` back-compat field (honestly overall-derived, NOT a second per-dim authority). Does NOT borrow `conservativeScore` (no per-pass page scores exist in this mode). |
| `artifact/build.ts` | PURE | `buildRedesignArtifact(input: { url; directions; ranking; retrieval; verdicts; referenceId?; tokensUsed }): RedesignArtifact` | Assemble the rich artifact, order directions by ranking, assert every `groundedInExemplarIds` exists in retrieval. |
| `artifact/to-findings.ts` | PURE | `directionToFindings(winner: RedesignDirection, gap: DnaDelta, measurements: MeasurementBundle): DesignFinding[]` | Project winner + DNA gap onto the **closed** `DesignFinding` enum as `minor` recommendations, MERGED with deterministic `measurementsToFindings` ground truth, ROI-sorted via `annotateRoi`. |
| `eval/taste-core.ts` | PURE | `tasteAgreement(pairs: TastePair[], verdicts: TasteVerdict[]): TasteAgreementResult`, `tasteMetricsFromVerdicts(referenceId: string, verdicts: TasteVerdict[]): TasteMetrics` | Corpus-vs-corpus agreement + generated-vs-reference metrics. Returns plain numbers; imports no bench framework. |

¹ `judge/pairwise.ts` and `judge/quality.ts` take the `TasteJudge` as a parameter, so the LLM is injected — both files unit-test with a stub judge and zero live model. `reconcileVerdicts` / the win-rate math are themselves pure.

### L2 — Adapters (thin IO/LLM/browser, each implements ONE contract interface)

| Path | Kind | Public API | Implements / reuses |
|---|---|---|---|
| `dna/page-adapter.ts` | ADAPTER | `createPageDnaExtractor(): DesignDnaExtractor` | `DesignDnaExtractor`. **Lazy** `await import('../../../cli-design-audit.js')` → `extractDesignTokens` (mirrors `compare.ts:288` to avoid the circular dep), then pure `toDesignDNA`. |
| `retrieval/embedding-openai.ts` | ADAPTER | `OpenAiEmbeddingProvider: EmbeddingProvider`, `resolveEmbeddingProvider(opts?): EmbeddingProvider` | The network half. `OpenAiEmbeddingProvider` is a `dynamic import('openai')` adapter; `resolveEmbeddingProvider` returns it when a key exists, else the pure `HashEmbeddingProvider`. Isolating the dynamic import here keeps `embedding-hash` literally pure and testable with no env-key gymnastics. |
| `corpus/store.ts` | ADAPTER | `createFileCorpusStore(dir: string): CorpusStore` | Implements the FULL `CorpusStore` (`CorpusReader` + `CorpusWriter`) over JSONL + sidecar screenshots; fail-closed on missing dir. Uses `corpus/schema`. The audit path receives only its `CorpusReader` surface. |
| `corpus/build.ts` | ADAPTER | `buildExemplar(opts): Promise<Exemplar>`, `ingestCorpus(opts): Promise<{ added; failed }>` | Offline authoring (not on the audit hot path) — the ONLY consumer of `CorpusWriter`. Reuses `ripSite`, `extractDesignTokens`, `classifyEnsemble`, `dna/descriptor`, `retrieval/embedding-openai` (`resolveEmbeddingProvider`), `corpus/store`. |
| `generate/generator.ts` | ADAPTER | `createBrainGenerator(brain: Brain, opts?): RedesignGenerator` | `RedesignGenerator`. Fans out one `brain.complete` per exemplar via `mapWithConcurrency`, streams via `onDirection`, parses with `generate/parse`. A single failed call is dropped, not fatal. |
| `judge/text-judge.ts` | ADAPTER | `createTextJudge(brain: Brain): TasteJudge` | `TasteJudge` (default). One `brain.complete` per comparison over DNA/direction summaries; parses with `judge/parse`. **No `brain.auditDesign` abuse.** |
| `artifact/render.ts` | ADAPTER | `renderArtifactMarkdown(a): string`, `renderArtifactJson(a): string`, `writeArtifact(a, dir): Promise<{ jsonPath; markdownPath }>` | Pure renderers + a thin disk writer. |
| `reference-context.ts` | ADAPTER | `resolveReferenceContext(ref: string \| undefined, deps: { extractor: DesignDnaExtractor }): Promise<ReferenceContext \| undefined>` | Resolve `--reference` (url/rip/tokens) into a `ReferenceContext` **once**; throws an explicit error on failure (fail-closed). Lives in its own small module — not the fat orchestrator. |

### L3 — Core + wiring

| Path | Kind | Public API | Responsibility |
|---|---|---|---|
| `engine/core.ts` | ORCH (pure-ish) | `runRedesignCore(deps: ReferenceEngineDeps, input: RedesignCoreInput): Promise<RedesignRunResult>` | The **single** retrieve→generate→judge→rank→score→artifact sequencer. Depends only on `contracts` + the pure cores it calls + the injected `deps` interfaces. Holds ZERO domain logic — every decision is a delegated pure core. Retrieves against the pre-loaded `input.corpus`; **never** calls `store.load()` itself (acquire-once is the entrypoint's job). |
| `engine/wiring.ts` | ORCH | `buildDefaultDeps(brain: Brain, config: ReferenceGroundedConfig): ReferenceEngineDeps` | The composition root: the ONE place that picks concrete adapters (`createPageDnaExtractor`, `createFileCorpusStore` exposed as the `CorpusReader` half, `resolveEmbeddingProvider`, `{ retrieve }`, `createBrainGenerator`, `createTextJudge`, `{ rank: rankDirections }`) and assembles `ReferenceEngineDeps`. Never imports `core`. |

### L4 — Entrypoints (two return-shapings of the one core)

| Path | Kind | Public API | Responsibility |
|---|---|---|---|
| `run.ts` | ORCH | `runReferenceRedesign(opts: { url; reference?; brain; config?; onDirection? }): Promise<RedesignArtifact>` | Rich library/CLI entry. Resolves the reference once, loads the corpus once via `deps.store.load()`, builds deps via `wiring`, calls `core`, writes + returns the `RedesignArtifact`. |
| `pipeline/evaluate-reference.ts` | ORCH | `evaluateReferenceGrounded(brain: Brain, input: { url; classification; measurements; screenshotPath?; reference?; corpus; config }): Promise<PageAuditResult>` | The flagged STAGE-6 replacement. Receives the once-loaded `corpus` (acquired above the page loop in `cli-design-audit.ts`), calls `core`, writes the artifact, maps `RedesignRunResult` → `PageAuditResult` (`score`, `summary`, `strengths`, `findings`, `designSystemScore`, `tokensUsed`) and surfaces `dimensionScores` for the stage-8 `precomputedScores` hook so stages 7-9 run unchanged. |

### L5 — Barrel

| Path | Public API |
|---|---|
| `index.ts` | `export * from './contracts.js'`; `runReferenceRedesign` (run); `evaluateReferenceGrounded` (pipeline/evaluate-reference); `createFileCorpusStore` (corpus/store); `buildExemplar`, `ingestCorpus` (corpus/build); `tasteAgreement`, `tasteMetricsFromVerdicts` (eval/taste-core). |

---

## 2. Data flow

```
            ┌─────────────────────────── existing v1 stages, REUSED unchanged ──────────────────────────┐
page ──▶ classifyEnsemble ──▶ PageClassification    gatherMeasurements ──▶ MeasurementBundle   (screenshot)
            └──────────────────────────────────────────────┬───────────────────────────────────────────┘
                                                            │  (flag-gated STAGE-6 branch in pipeline.ts)
                                                            ▼
                                              pipeline/evaluate-reference.ts  ── or ──  run.ts
                                                            │  buildDefaultDeps(brain, config)
                                                            ▼
                                                    engine/core.runRedesignCore(deps, input)
   1. deps.extractor.extract({url})                       → DnaCapture.dna           (reuse extractDesignTokens)
   2. dna/descriptor.aestheticDescriptor(dna) → deps.embedder.embed([…]) → CorpusQuery.aestheticVector
   3. input.corpus (loaded ONCE per run, above the page/rep loops);  deps.matcher.retrieve(query, input.corpus) → RetrievalResult[]   ← de-hardcoding
   4. engine/guard.decideProceed(...)   → abort with reason if no exemplars AND no reference
   5. deps.generator.generate(ctx, hits) → RedesignDirection[]            (concurrent brain.complete, streamed)
   6. judge/quality.assessPageQuality(deps.judge, page, exemplars, {dimensions}) → QualityAssessment   (ABSOLUTE leg)
         (one dimension-scoped comparison set per Dimension → overallWinRate + per-Dimension dimensionWinRates)
      judge/pairwise.judgePair(deps.judge, …) over direction pairs       → TasteVerdict[]  (RELATIVE leg)
         (both legs planned by engine/budget, run via mapWithConcurrency)
   7. deps.ranker.rank(ids, verdicts) → RankResult (winner)
   8. engine/score-core.deriveHeadlineScore(quality, measurements)  → 0-10
      engine/score-core.toDimensionScores(quality)                  → Record<Dimension,DimensionScore>  (precomputedScores hook)
      engine/score-core.toDesignSystemScore(quality)                → DesignSystemScore                 (8-dim back-compat field)
   9. artifact/build.buildRedesignArtifact(...) → RedesignArtifact
      artifact/to-findings.directionToFindings(winner, dnaDelta, measurements) → DesignFinding[]
                                                            │
                                                            ▼   RedesignRunResult
                ┌───────────────────────────────────────────┴───────────────────────────────────┐
        run.ts: writeArtifact + return RedesignArtifact          pipeline: map → PageAuditResult
                                                                  → STAGE 7 checkEthics (caps score)
                                                                  → STAGE 8 buildAuditResult (precomputedScores = dimensionScores ⇒ no 2nd LLM)
                                                                  → STAGE 9 telemetry (unchanged shape)
```

**Eval flavour:** `eval/taste-core` maps the same `TasteVerdict[]` into `TasteMetrics` (generated-vs-reference, for the GEPA `score-adapter` taste branch) and `TasteAgreementResult` (corpus-vs-corpus, for an `evaluateTastePairwise` `FlowEnvelope` sibling of `calibration.ts`). Win-rate CIs come from `scripts/lib/stats.mjs` (`wilsonInterval`/`bootstrapDiff95`) at the bench layer — never re-implemented here.

---

## 3. Dependency DAG (proof of acyclicity)

Edges point **only to strictly-lower layers**, with two documented same-layer (L1→L1) edges that are themselves a DAG. No edge ever points upward, so the whole graph is acyclic.

```
L0  contracts.ts                         (no engine imports)
      ▲
L1  config, dna/derive, dna/delta, dna/descriptor, corpus/schema,
    retrieval/embedding-hash, retrieval/matcher*, generate/prompt, generate/parse,
    judge/prompt, judge/parse, judge/rank, judge/pairwise†, judge/quality†,
    engine/budget, engine/guard, engine/score-core, artifact/build,
    artifact/to-findings‡, eval/taste-core§
      ▲
L2  dna/page-adapter, retrieval/embedding-openai, corpus/store, corpus/build,
    generate/generator, judge/text-judge, artifact/render, reference-context
      ▲
L3  engine/core, engine/wiring
      ▲
L4  run.ts, pipeline/evaluate-reference.ts
      ▲
L5  index.ts
```

**Same-layer (L1→L1) edges — verified acyclic:**
- `retrieval/matcher` → `retrieval/embedding-hash` (`cosineSimilarity` only — the pure half). `embedding-hash` does **not** import `matcher`, and the network adapter `embedding-openai` is L2 (matcher never touches it). ✔
- `judge/quality` → `judge/pairwise` (+ `dna/derive` for summaries); `judge/pairwise` → (only `contracts`). `pairwise` does **not** import `quality`. ✔
- `artifact/to-findings`‡ → `dna/delta` (+ existing `evaluate.measurementsToFindings`, `roi.annotateRoi`). `dna/delta` imports only `contracts`. ✔
- `eval/taste-core`§ → `judge/rank`; `rank` imports only `contracts`. ✔

**Key non-edges that keep it clean:**
- `engine/core` imports the pure cores + the injected interface types — **never** an L2 concrete adapter. Concretes are supplied by `engine/wiring` at the composition root.
- `engine/wiring` imports concretes but **never** `engine/core`. The two L3 modules are siblings with no edge between them; `run.ts`/`evaluate-reference.ts` depend on both.
- `retrieval/matcher`* takes a pre-computed `CorpusQuery.aestheticVector` and imports **no** `EmbeddingProvider` concrete — embedding happens in the orchestrator, killing the dual-supply ambiguity.
- No engine module imports `pipeline.ts`, `cli.ts`, or `cli-design-audit.ts` **statically**; the one unavoidable reach into `cli-design-audit.ts` (`extractDesignTokens`) is a **lazy `await import`** confined to `dna/page-adapter` + `corpus/build`, exactly as `compare.ts` already does.

**This acyclicity is enforced, not just asserted.** A new `check:boundaries` rule covers the engine dir and fails the build on any STATIC import of the upward modules:

```js
// scripts/check-boundaries.mjs
{
  name: 'reference-engine-no-static-upward-imports',
  from: /^src\/design\/audit\/reference\//,
  blocked: [/^src\/cli\.ts$/, /^src\/cli-design-audit\.ts$/, /^src\/design\/audit\/pipeline\.ts$/, /^src\/runner\.ts$/],
  staticOnly: true,
}
```

Because the legitimate reach into `cli-design-audit.ts` is a **dynamic** `await import`, the checker is extended to classify each specifier as static-vs-dynamic and a `staticOnly` rule ignores dynamic imports — so the lazy import in `dna/page-adapter` + `corpus/build` stays legal while a future `import { extractDesignTokens } from '../../../cli-design-audit.js'` is rejected. Without this rule the boundary checker covers only `src/drivers/`, `src/brain/`, `src/artifacts/`; this rule closes that gap for `src/design/audit/reference/`. No engine file imports `src/cli.ts`/`src/runner.ts` statically.

---

## 4. Flag strategy — default stays byte-identical

The engine is reached ONLY by opt-in. Flag absent ⇒ `evalMode` is `'v1'`, the new branch is never entered, and `buildEvalPrompt` (and its `--reproducibility` determinism) is untouched.

Threading (each step a single localised edit, all deferrable to a wiring phase **after** the engine + its unit tests land with ZERO edits to existing files):

1. **CLI surface** — `src/cli.ts:169` parseArgs: add `reference: { type: 'string' }` and `'reference-grounded': { type: 'boolean' }` (copy the `'rubrics-dir'` / `reproducibility` templates). `src/cli.ts:367`: pass `reference: values.reference, referenceGrounded: values['reference-grounded']` into `runDesignAudit`.
2. **Options home** — `cli-design-audit.ts:319` `DesignAuditOptions`: add `reference?: string; referenceGrounded?: boolean`. Derive `evalMode = (referenceGrounded || reference) ? 'reference-grounded' : 'v1'`. **Not** `config.ts`/`DriverConfig` (the audit path bypasses `loadConfig`).
3. **Acquire-once** — `cli-design-audit.ts:338` `runDesignAudit`: before the page/rep loops, `resolveReferenceContext(opts.reference, …)` ONCE **and** load the exemplar corpus ONCE (`deps.store.load()` / `createFileCorpusStore(config.corpusDir).load()`); bundle `{ evalMode, reference, corpus, config }` into a `referenceCommonOpts` object and spread it into **all four** `auditOnePage` call sites (`435, 524, 791, 1126`), exactly like `...ethicsCommonOpts`. The corpus is parsed + schema-validated once and reused across every page and rep, so a multi-page / multi-rep run never re-reads it — protecting the ±0.5 reproducibility gate. Partial wiring would silently run v1 on some paths.
4. **Pipeline option** — `pipeline.ts:35/58` `AuditOnePageOptions`: add `evalMode?: EvalMode; reference?: ReferenceContext; corpus?: Exemplar[]; referenceConfig?: ReferenceGroundedConfig` as siblings of `overrides` — **not** inside `AuditOverrides`.
5. **The single guarded branch** — `pipeline.ts` (STAGE 6): `evaluateReferenceGrounded` returns a `ReferenceEvaluation` `{ result, dimensionScores }`, so the branch captures both — the `PageAuditResult` for stages 7-9 and the engine's per-dimension scores for stage 8:
   ```ts
   let precomputedScores: Record<Dimension, DimensionScore> | undefined
   if (opts.evalMode === 'reference-grounded') {
     const evaluation = await evaluateReferenceGrounded(brain, { url, classification, measurements, screenshotPath, reference: opts.reference, corpus: opts.corpus, config: opts.referenceConfig ?? resolveReferenceConfig() })
     result = evaluation.result
     precomputedScores = evaluation.dimensionScores
   } else {
     result = await evaluatePage(brain, { /* …existing… */ })
   }
   ```
   Stages 1-5 and 7-9 are untouched; `classifyEnsemble` + `gatherMeasurements` still run (buildAuditResult needs the ensemble; ethics needs a numeric score). `precomputedScores` stays `undefined` on the v1 path, so stage 8 is byte-identical there.
6. **Stage-8 single authority** — in reference mode, `buildAuditResult` is called with `precomputedScores: evaluation.dimensionScores` (a `Record<Dimension, DimensionScore>` over the 5 product-quality dims — the EXACT type `precomputedScores` requires), so its second multidim `brain.auditDesign` LLM call AND the `generatePatches` call are skipped. One scoring authority, no redundant call. (The engine's flat 8-dim `designSystemScore` is a *different* type and CANNOT be passed here — it flows separately into the `PageAuditResult.designSystemScore` back-compat field.)

**Export promotions (the ONLY edits outside the engine dir, each an `export` keyword, zero runtime change):**
- `src/design/compare.ts`: promote `diffTokens` and `pixelDiff` to exports (for the optional rendered before/after). *Deferrable — the engine's `dnaDelta` does not need them.*

> Corrected vs panel: `measurementsToFindings` (evaluate.ts:479), `conservativeScore` (evaluate.ts:839), and `annotateRoi` (roi.ts:58) are **already exported** — verified in-repo. No promotion needed for those. Only `diffTokens`/`pixelDiff` are module-private.

---

## 5. Build order

1. **`contracts.ts`** (done) — typecheck clean.
2. **L1 pure cores** + their unit tests (no existing-file edits): `config`, `dna/derive`, `dna/delta`, `dna/descriptor`, `retrieval/embedding-hash`, `retrieval/matcher`, `corpus/schema`, `generate/prompt`, `generate/parse`, `judge/prompt`, `judge/parse`, `judge/pairwise`, `judge/quality`, `judge/rank`, `engine/budget`, `engine/guard`, `engine/score-core`, `artifact/build`, `artifact/to-findings`, `eval/taste-core`.
3. **L2 adapters** + adapter tests (injected fakes): `dna/page-adapter`, `retrieval/embedding-openai`, `corpus/store`, `corpus/build`, `generate/generator`, `judge/text-judge`, `artifact/render`, `reference-context`.
4. **L3** `engine/core` + `engine/wiring`; integration test with all deps faked.
5. **L4** `run.ts`, `pipeline/evaluate-reference.ts`; **L5** `index.ts`.
6. **Corpus seed**: author a starter corpus via `ingestCorpus` (variant/Mobbin/Awwwards exemplars) into the corpus dir.
7. **Bench seams** (outside `src/`): `TrialResult.tasteMetrics` field + `AuditScoreAdapter` taste branch + `objectiveVectorFromTrials` taste branch + `evaluateTastePairwise` `FlowEnvelope` — all importing `eval/taste-core`, registered the additive way the patch-synthesis target proved.
8. **Wiring phase**: the 6 flag edits in §4 + the two export promotions + the `reference-engine-no-static-upward-imports` `check:boundaries` rule (with the static-vs-dynamic classifier extension, §3). Gate behind the flag; run Tier1 to confirm byte-identical default; run `pnpm check:boundaries` to confirm the engine dir is now covered.

Phases 1-5 ship the entire engine with **zero** edits to existing files; it is exercised from unit tests and the bench harness. Step 8 is the only phase that touches existing files (`scripts/check-boundaries.mjs` is the build-tooling part of that phase).

---

## 6. Per-module test plan

| Module | Test |
|---|---|
| `contracts.ts` | `tsc --noEmit` is the gate; a `satisfies` test pins `DesignFinding`-compatible projections so an enum drift fails to compile. |
| `config` | defaults stable; partial override merges field-by-field; k/directionCount/budget clamped to minimums. |
| `dna/derive` | on committed `tokens.json` fixtures: type-scale ratio, color-role carry-through from `cluster`, `gridBaseUnit`/density, motion durations; `summarizeDNA` respects `maxChars`. Deterministic, no IO. |
| `dna/delta` | identical pair → empty delta + stable summary; role add/remove/change; ratio shift. |
| `dna/descriptor` | descriptor snapshot; `structuralFeatures` fixed-length, order-stable, identical across calls. |
| `retrieval/embedding-hash` | hash provider: same text → identical vector, fixed dims; cosine bounds/symmetry. Pure — no network, no env needed. |
| `retrieval/embedding-openai` | `resolveEmbeddingProvider` returns the hash provider when no key (no network in matcher/core tests); the OpenAI provider's `dynamic import('openai')` path is integration-gated. |
| `retrieval/matcher` | synthetic 6-exemplar corpus: nearest-by-vector wins; pageType filter excludes mismatches; **novel pageType still resolves to nearest neighbour** (de-hardcoding proof); eloRating→id tie-break; k bound. |
| `corpus/schema` | round-trip serialise/parse; missing `aestheticVector`/`dna`/`pageType` rejected; no eval/prototype pollution on hostile rows. |
| `corpus/store` | tmp-dir round-trip upsert/load; `get` → null on miss (no fabrication); `resolveScreenshot` absolute. A `satisfies CorpusReader` / `satisfies CorpusWriter` test pins that each half is independently consumable. |
| `corpus/build` | inject fake rip/extract/classify/embed → well-formed `Exemplar`, stable id, seeded elo; `ingestCorpus` captures per-item failures. Network path integration-gated. |
| `generate/prompt` | byte-identical for fixed inputs; exemplar id present; DNA bounded by `maxRefChars`. |
| `generate/parse` | happy/fenced/truncated/hallucinated-id → typed error not fabricated direction. |
| `judge/prompt` | snapshot; reference injected when present; anti-bias clause present; text vs vision differ only in image clause. |
| `judge/parse` | well-formed verdict parsed; garbage → tie+reason. |
| `judge/pairwise` | stub judge: both slot orders issued; agreeing orders → confident winner; disagreeing → tie (slot bias neutralised); margins averaged. |
| `judge/quality` | stub judge: page-vs-exemplar `overallWinRate` computed; ties excluded from `comparisons`; with `opts.dimensions` set, one comparison set per `Dimension` is issued and `dimensionWinRates` is keyed by the right `Dimension` (a stub that favours dim X only lifts X's win-rate — proving per-dim resolution, not one number stamped 5×); without it `dimensionWinRates` is undefined. |
| `judge/rank` | transitive verdicts (A>B>C) → A first; `updateElo` symmetric + conserves total; `bradleyTerry` converges on fixed seed; calibration shifts toward votes monotonically. |
| `engine/budget` | `planJudgeBudget` caps pairs/reps and folds the per-`Dimension` expansion into `qualityPairs`, dropping `qualityDimensions` to 0 (overall-only) when `maxJudgeCalls` can't afford the full set; `mapWithConcurrency` respects N, preserves order, propagates errors. |
| `engine/guard` | empty corpus + no reference → `{ ok:false, reason }`; reference present → ok. |
| `engine/score-core` | win-rate→0-10 monotonic; `hasBlockingIssues` floors the score; `toDimensionScores` returns all 5 `Dimension` keys as rich `DimensionScore`s (win-rate→score, `comparisons`→range/confidence), a dim absent from `dimensionWinRates` filled at `confidence:'low'` with an explicit summary (never silently faked), and `satisfies Record<Dimension, DimensionScore>` so it drops into `precomputedScores` unchanged; `toDesignSystemScore` fills all 8 design-system dims from `overallWinRate` (back-compat field). |
| `artifact/build` | directions ordered by ranking; winner first; every `groundedInExemplarIds` ∈ retrieval. |
| `artifact/to-findings` | **every** `finding.category` ∈ closed enum; contrast/a11y findings come ONLY from `measurementsToFindings`; directional findings emitted `minor` (no patch-downgrade corruption); ROI-sorted. |
| `artifact/render` | markdown contains ASCII diagram + type/color/motion blocks + cited ids; `writeArtifact` lands both files in a tmp dir. |
| `reference-context` | url/rip/tokens kinds resolve; bad ref → explicit throw (fail-closed), never a default-looking context. |
| `dna/page-adapter` | inject fake `extractDesignTokens` → forwards to `toDesignDNA`, merges measurements, forwards screenshots. Browser path integration-gated only. |
| `generate/generator` | fake Brain: N concurrent calls → N directions; `onDirection` fires per resolution; one failed call dropped, batch survives; total calls == count. |
| `judge/text-judge` | fake Brain: exactly one `complete` per comparison; verdict parsed; never calls `auditDesign`. |
| `engine/core` | all deps faked + in-memory `input.corpus` + fixture tokens/measurements: returns `RedesignRunResult` with required fields (incl. `dimensionScores`); a spy `store.load` is **never** called by the core (acquire-once lives above it); guard aborts on zero retrieval; artifact assembled; exactly one contrast finding (parity). |
| `engine/wiring` | returns a `ReferenceEngineDeps` whose members satisfy each interface; selects hash embedder with no key. |
| `run.ts` / `pipeline/evaluate-reference.ts` | reference + corpus resolved once + reused across pages/reps (a spy `store.load` fires exactly once per run, not per page — determinism + reproducibility); `evaluateReferenceGrounded` returns the `PageAuditResult` contract (url, numeric score, summary, strengths, findings, designSystemScore) and its `dimensionScores` is accepted verbatim as `buildAuditResult` `precomputedScores` so stages 7-9 stay valid. |
| `scripts/check-boundaries.mjs` | the `reference-engine-no-static-upward-imports` rule fires on a fixture static `import … from '../../../cli-design-audit.js'` under `src/design/audit/reference/` and stays silent on the real lazy `await import(...)`, proving the static-vs-dynamic classifier. |
| `eval/taste-core` | fixture verdicts → agreement counts strong-preferred; ties excluded from n; `winsVsReference`/`comparisons` match the objective-mapping pattern; empty → 0, never NaN. |

---

## 7. Reuse map (existing symbol → where used)

| Existing symbol (file) | Export status | Used by | Purpose |
|---|---|---|---|
| `extractDesignTokens` (`cli-design-audit.ts:1989`) | exported | `dna/page-adapter`, `corpus/build` (lazy import) | Page → `DesignTokens` (+ assets, screenshots), no extra LLM. |
| `ripSite` (`design/rip.ts:162`) | exported | `corpus/build` | Offline working copy + `manifest.json` for exemplar authoring. |
| `gatherMeasurements` (`measure/index.ts:17`) | exported | reused **upstream** by the pipeline; result threaded into the engine | Deterministic contrast+a11y ground truth. |
| `measurementsToFindings` (`evaluate.ts:479`) | **already exported** | `artifact/to-findings` | Inject ground-truth findings (LLM forbidden from inventing them). |
| `annotateRoi` (`roi.ts:58`) | **already exported** | `artifact/to-findings` | ROI sort identical to v1. |
| `conservativeScore` (`evaluate.ts:839`) | **already exported** | *not used for the headline* (no per-pass page scores in this mode) | — listed only to record it was checked; `score-core` owns scoring. |
| `classifyEnsemble` (`classify-ensemble.ts:59`) | exported | reused upstream; `corpus/build` for exemplar `pageType`/`jobToBeDone` | Page typing; replaces the domain tables. |
| `composeRubric` / `composeRubricFromProfile` (`rubric/loader.ts:226/269`) | exported | optional `GenerationContext.rubricBody` / judge `rubricBody` | Scoring-criteria seed. |
| `buildAuditResult` (`build-result.ts:61`) | exported | pipeline STAGE 8, via `precomputedScores: Record<Dimension, DimensionScore>` (supplied by `score-core.toDimensionScores`) | Multidim result without a second LLM call. The engine's flat `DesignSystemScore` is NOT type-compatible here — `dimensionScores` is. |
| `checkEthics` (`ethics/check.ts:60`) | exported | pipeline STAGE 7, unchanged | Score cap on the engine's numeric score. |
| `brain.complete` (`brain/index.ts:2309`) | public | `generate/generator`, `judge/text-judge` | Text generation + default judge. No Brain edit. |
| `brain.auditDesign` (`brain/index.ts:2133`) | public | **NOT used by the judge** | Deliberately avoided — overloading it is contract abuse (see §9). The vision judge uses the clean sibling seam `brain.completeVision` instead. |
| `brain.completeVision` (`brain/index.ts`) | public | `judge/vision-model.createBrainVisionModel` → `judge/vision-judge` | Multimodal sibling of `complete`: one Brain per `ModelRef`, screenshots in → verdict text out. The clean vision seam (NOT `auditDesign`). |
| `diffTokens` (`compare.ts:62`) | **private — promote** | optional rendered before/after only | Token-altitude delta; the engine's `dnaDelta` does NOT depend on it. |
| `pixelDiff` (`compare.ts:24`) | **private — promote** | optional rendered before/after | Pixel scoring of rendered directions. |
| `DesignTokens`/`ColorToken`/`ViewportTokens`/`TypeScaleEntry`/`FontFamily` (`src/types.ts`) | exported | `contracts` re-export, `dna/derive` | DNA derives purely from these (clusters + gridBaseUnit precomputed). |
| `DesignFinding`/`DesignSystemScore` (`src/types.ts`) | exported | `contracts` re-export | Exact emit contract + 8-dim back-compat score. |
| `Dimension`/`DimensionScore` (`audit/score-types.ts:39/56`) | exported | `contracts` re-export, `judge/quality`, `engine/score-core` | The 5-dim product-quality scoring taxonomy + rich per-dim shape `precomputedScores` requires. |
| `PageClassification`/`PageType`/`MeasurementBundle`/`PageAuditResult` (`audit/types.ts`) | exported | `contracts` re-export | Stage contracts; return-shape. |
| `wilsonInterval`/`bootstrapDiff95`/`spreadVerdict` (`scripts/lib/stats.mjs`) | exported | bench seams | Taste win-rate CI + promotion verdict. No hand-rolled stats. |
| `FlowEnvelope`/`statusFor` (`bench/design/eval/scorecard.ts`) | exported | corpus-vs-corpus CI gate | Wrap `eval/taste-core` output. |
| `ObjectiveVector`/`paretoFront`/`scalarScore` + `patchMetrics` branch (`bench/design/gepa/*`) | exported | generated-vs-reference GEPA objective | Axis-remap (recall←winsVsReference, precision←corpusOrderAgreement); no vector widening. |
| `evaluateCalibration` (`bench/design/eval/calibration.ts:62`) | exported | template for `evaluateTastePairwise` | Same corpus walk + `FlowEnvelope`. |

---

## 8. Does NOT modify existing audit behaviour — guarantee

1. **All new code lives under `src/design/audit/reference/`.** Phases 1-5 add zero edits to any existing file; the engine is exercised by unit tests and the bench harness alone.
2. **The v1 path is untouched.** `evaluatePage`, `buildEvalPrompt`, `inferAuditMode`, `DEFAULT_DEEP_PASSES_BY_TYPE`, `PASS_DEFINITIONS`, `profileToFragmentIds`, and the `AuditPassId` union are neither imported-for-mutation nor edited. `buildEvalPrompt`'s `--reproducibility` byte-determinism is preserved because the engine never calls it.
3. **The flag defaults off.** With `--reference`/`--reference-grounded` absent, `evalMode` is `'v1'`; the STAGE-6 branch (§4.5) is never entered; the prompt, findings, scores, and telemetry envelope are byte-identical to today. The new option lives on `AuditOnePageOptions` as a sibling of `overrides` — never inside `AuditOverrides`, never on `DriverConfig`.
4. **Return-shape compatibility.** The engine returns the required `PageAuditResult` fields (`url`, numeric `score`, `summary`, `strengths`, `findings`) plus `classification`/`measurements`/`designSystemScore`/`tokensUsed`, so STAGE 7 (ethics cap), STAGE 8 (`buildAuditResult`), and STAGE 9 (telemetry) run unchanged. `DesignFinding.category` stays inside the closed enum; the rich `RedesignDirection` payload is carried by the first-class `RedesignArtifact` (written to disk + returned by `run.ts`), never smuggled through the v1 finding shape.
5. **Single scoring authority.** The headline 0-10, the 5-dim `dimensionScores`, and the 8-dim `designSystemScore` all derive from the ONE absolute quality leg (`engine/score-core` over `QualityAssessment`). In reference mode the pipeline feeds `dimensionScores` (the `Record<Dimension, DimensionScore>` shape stage 8 requires) to `buildAuditResult` as `precomputedScores`, so stage 8 makes no second multidim LLM call — no two scoring authorities, no `conservativeScore`-on-nonexistent-inputs leak. The flat `designSystemScore` is a back-compat projection of the same `overallWinRate`, not an independent authority.
6. **The only edits outside the engine dir** are: the 6 localised flag-wiring edits in §4 (deferred phase) and two `export`-keyword promotions in `compare.ts` (deferrable). Each is additive and behaviour-neutral when the flag is off.

---

## 9. Reviewer-raised risks → resolutions

| Risk (raised by) | Resolution |
|---|---|
| **Fabricated headline / two scoring authorities** (D1, D2, D3) | `engine/score-core.deriveHeadlineScore` + an explicit **absolute** quality leg (`judge/quality`, page vs exemplars → win-rate). `conservativeScore` is NOT borrowed. Stage 8 fed via `precomputedScores = score-core.toDimensionScores(quality)`, a real `Record<Dimension, DimensionScore>` over the 5 product dims (type-compatible with `buildAuditResult`) ⇒ one authority. |
| **Fabricated multi-dim score: per-dim win-rates with no producer** (review) | `dimensionWinRates` is now keyed by the 5-dim `Dimension` taxonomy and is only populated when the quality leg runs **dimension-scoped** comparisons (`JudgePairInput.dimension` + `RawVerdict.dimension`). Each dim is genuinely judge-resolved; a dim with no signal is left out of `dimensionWinRates` and filled at `confidence:'low'`, never the overall number stamped across dims. The flat 8-dim `designSystemScore` is documented as an honest overall projection. |
| **`DesignFinding` hostile to generative output; rich payload dropped** (D1, D2, D3) | `RedesignArtifact` is first-class (returned + written), read by the taste eval. `directionToFindings` emits directional items as `minor`, so the major/critical patch-or-downgrade rule never corrupts them. |
| **Circular import via static `extractDesignTokens`** (D1) | Lazy `await import('../../../cli-design-audit.js')` confined to `dna/page-adapter` + `corpus/build`, mirroring `compare.ts`. Pure cores never touch it. (Static extraction into `src/design/tokens` noted as a future refactor — out of scope under additive-only.) |
| **Retrieval on free-form/ fabricated `intent`** (D1) | `RetrieveWeights` defaults aesthetic+pageType dominant, `job` low; `pageType` is a hard filter; the matcher consumes a pre-computed vector. Documented that `--profile` runs lean on aesthetic+type. |
| **Vision judge overloads `auditDesign` / smuggles `PageState`** (D1, D2, D3) | The shipped `TasteJudge` is **text-only**. `auditDesign` is explicitly NOT used by the judge. A vision judge is a future drop-in implementing the same narrow `TasteJudge` interface once a clean `brain.compareVisual` seam exists — no contract abuse ships. |
| **Two near-parallel orchestrators drift** (D3) | ONE `engine/core.runRedesignCore`; `run.ts` and `pipeline/evaluate-reference.ts` differ ONLY in return-shaping. |
| **contracts↔impl interface re-export cycle** (D2, D3) | All 8 boundary interfaces are declared IN `contracts.ts`; impl modules import them. No re-export cycle. |
| **`CorpusStore` god-interface: runtime path reaches authoring mutators** (review) | Split into `CorpusReader` (load/get/resolveScreenshot) + `CorpusWriter` (upsert/saveScreenshot); `CorpusStore = CorpusReader & CorpusWriter`. `ReferenceEngineDeps.store` is typed `CorpusReader`, so `engine/core` + `matcher` cannot reach `upsert`/`saveScreenshot`; only offline `corpus/build` holds the writer. |
| **Per-page corpus re-read threatens reproducibility** (review) | The corpus is loaded + schema-validated ONCE per run (acquire-once, like `ReferenceContext`) and threaded as `RedesignCoreInput.corpus`; the core never calls `store.load()`. No repeated O(corpus) disk IO across pages/reps. |
| **Latent engine↔cli-design-audit↔pipeline cycle, unenforced** (review) | The lazy `await import` is now backstopped by a `check:boundaries` rule (`reference-engine-no-static-upward-imports`, §3) with a static-vs-dynamic classifier: a future STATIC import of `cli-design-audit.ts`/`pipeline.ts`/`cli.ts` from the engine dir fails the build; the legitimate dynamic import stays legal. |
| **Network boundary inside a "PURE" module** (review) | `retrieval/embedding.ts` is split into pure `retrieval/embedding-hash.ts` (`HashEmbeddingProvider` + `cosineSimilarity`) and adapter `retrieval/embedding-openai.ts` (`dynamic import('openai')` + `resolveEmbeddingProvider`). `matcher` imports only the pure half; PURE stays literally pure. |
| **`dnaDelta` claims `diffTokens` reuse across altitudes** (D3) | `dnaDelta` is pure over `DesignDNA` only and depends on no `diffTokens`. `diffTokens` is reserved for the optional token-altitude rendered before/after. |
| **Cost: ~15 LLM calls/page** (D1, D2, D3) | `precomputedScores = dimensionScores` removes stage-8 LLM calls; `engine/budget` caps direction count (2-3) + judge calls + reps and runs independents via `mapWithConcurrency`; optional `screenThenValidate` two-stage. The dimension-scoped quality leg (one comparison set per `Dimension`) is opt-in and counted by `planJudgeBudget` into `qualityPairs` (bounded by `maxJudgeCalls`); when the budget can't afford it the leg falls back to overall-only and `dimensionWinRates` is omitted — honestly, rather than faking per-dim numbers. |
| **Orchestrator accretes unhoused decisions** (D1, D2, D3) | Each decision has its own pure core: scoring (`score-core`), fail-closed (`guard`), budget (`budget`), artifact (`artifact/build`), findings (`artifact/to-findings`). `core` only sequences. |
| **Query dual-supplies the embedding** (D2 called it `RetrievalQuery`) | Our `CorpusQuery` carries only `aestheticVector` (authoritative, computed once by the orchestrator). The matcher imports no embedder. |
| **`resolveReferenceContext` trapped in the fat orchestrator** (D3) | Its own `reference-context.ts` module, imported by both the CLI plumbing and entrypoints. |
| **`contracts.ts` becomes a logic dumping ground** (all) | Enforced "types + interfaces only, zero runtime" — stated here and checked in review. |
| **Stale reuse inventory** (D3) | Re-verified in-repo: `measurementsToFindings`/`conservativeScore`/`annotateRoi` already exported; only `diffTokens`/`pixelDiff` need promotion. §7 corrected. |
