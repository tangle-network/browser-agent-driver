/**
 * L4 entrypoint — the flagged STAGE-6 replacement. ORCH: it runs the ONE shared
 * core and maps its result onto the EXISTING `PageAuditResult` contract so the
 * reference-grounded path drops into the v1 pipeline and stages 7-9 run unchanged.
 *
 * It is the sibling of `run.ts`: the SAME `engine/core.runRedesignCore`, a
 * different return-shaping. Where `run.ts` surfaces the rich `RedesignArtifact`,
 * this maps `RedesignRunResult` → `PageAuditResult` via the pure
 * `artifact/to-findings.toReferencePageAuditResult` — never a second scoring pass.
 *
 * Acquire-once is honoured by the CALLER: the pipeline loads the corpus and
 * resolves the reference ONCE above the page/rep loops and threads them in
 * (`input.corpus`, `input.reference`), so this entry never reads the corpus from
 * disk and the core never calls `store.load()`.
 */

import type {
  PageClassification,
  MeasurementBundle,
  ReferenceContext,
  ReferenceGroundedConfig,
  PageAuditResult,
  Exemplar,
  ReferenceEngineDeps,
  Dimension,
  DimensionScore,
  RedesignArtifact,
} from '../contracts.js'
import { runRedesignCore } from '../engine/core.js'
import { buildDefaultDeps, type ReferenceBrain } from '../engine/wiring.js'
import { toReferencePageAuditResult } from '../artifact/to-findings.js'
import { writeArtifact } from '../artifact/render.js'

/**
 * Per-page input for {@link evaluateReferenceGrounded}. `corpus` and `config` are
 * the once-acquired values threaded down from the pipeline; `reference` is the
 * once-resolved operator reference (when one was supplied).
 */
export interface EvaluateReferenceInput {
  url: string
  classification: PageClassification
  measurements: MeasurementBundle
  /** Page screenshot, carried onto the result and reserved for a future vision judge. */
  screenshotPath?: string
  /** Operator reference resolved once upstream; folded into `config.reference`. */
  reference?: ReferenceContext
  /** The exemplar corpus, loaded ONCE per run by the pipeline and reused across pages/reps. */
  corpus: Exemplar[]
  /** The resolved engine config (the pipeline supplies a fully-resolved bundle). */
  config: ReferenceGroundedConfig
}

/**
 * The result of one reference-grounded page evaluation.
 *
 * `result` is the `PageAuditResult` stages 7-9 consume; its `score` is the single
 * headline authority. `dimensionScores` is the engine's per-`Dimension` surface,
 * surfaced HERE so the pipeline can hand it to stage-8's `buildAuditResult` as
 * `precomputedScores` — skipping the redundant `brain.auditDesign` scoring pass so
 * there is exactly ONE scoring authority and no second multidim LLM call.
 */
export interface ReferenceEvaluation {
  result: PageAuditResult
  dimensionScores: Record<Dimension, DimensionScore>
  /**
   * The rich engine output (all ranked directions with ASCII layout, type/colour/
   * motion systems, hierarchy, copy). Carried here so the CLI can surface the full
   * redesign brief instead of the lossy `DesignFinding` projection. The lossy
   * `PageAuditResult.findings` projection alone cannot represent it.
   */
  artifact: RedesignArtifact
}

/**
 * Evaluate one page in reference-grounded mode. Returns a `ReferenceEvaluation`:
 * the `PageAuditResult` (whose `score`, `summary`, `strengths`, `findings`, and
 * `designSystemScore` come from the single quality authority via
 * `toReferencePageAuditResult`) plus the engine's `dimensionScores` for the
 * stage-8 `precomputedScores` hook.
 *
 * `deps` defaults to the production composition root (`buildDefaultDeps`); it is
 * injectable only so the wiring unit-tests with deterministic fakes (no browser,
 * no live LLM). The pipeline never passes it.
 */
export async function evaluateReferenceGrounded(
  brain: ReferenceBrain,
  input: EvaluateReferenceInput,
  deps?: ReferenceEngineDeps,
): Promise<ReferenceEvaluation> {
  // The core grounds against `config.reference`, never a separate field, so fold
  // the once-resolved reference into the config the core reads.
  const config: ReferenceGroundedConfig = input.reference
    ? { ...input.config, reference: input.reference }
    : input.config

  const resolvedDeps = deps ?? buildDefaultDeps(brain, config)

  const result = await runRedesignCore(resolvedDeps, {
    url: input.url,
    classification: input.classification,
    measurements: input.measurements,
    ...(input.screenshotPath ? { screenshotPath: input.screenshotPath } : {}),
    corpus: input.corpus,
    config,
  })

  if (config.artifactDir) await writeArtifact(result.artifact, config.artifactDir)

  const audit = toReferencePageAuditResult(result)
  const withShot = input.screenshotPath ? { ...audit, screenshotPath: input.screenshotPath } : audit
  return { result: withShot, dimensionScores: result.dimensionScores, artifact: result.artifact }
}
