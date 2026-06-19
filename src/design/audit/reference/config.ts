/**
 * Reference-grounded engine configuration — the PURE defaults + clamped merge.
 *
 * Holds the frozen `DEFAULT_REFERENCE_CONFIG` (and its nested `EngineBudget`),
 * the frozen `DEFAULT_RETRIEVE_WEIGHTS`, and `resolveReferenceConfig`, which
 * folds operator overrides onto those defaults field-by-field and clamps the
 * numeric knobs (`k`, `directionCount`, and the budget counts) to their safe
 * minimums. No IO, no LLM, no env reads — fully deterministic.
 *
 * Design rules encoded here:
 *  - The defaults are the SINGLE place the engine's cost shape is decided; every
 *    other module receives a resolved `ReferenceGroundedConfig`, never a literal.
 *  - Overrides are a DEEP-partial (`budget` may be partially specified) so an
 *    operator can bump one knob (e.g. `judgeReps`) without restating the bundle.
 *  - Clamping is fail-safe, not fail-loud: a non-finite / sub-minimum override
 *    falls back to the default rather than producing a zero-budget run that
 *    would silently judge nothing.
 */

import type {
  ReferenceGroundedConfig,
  EngineBudget,
  RetrieveWeights,
  ModelRef,
} from './contracts.js'

/**
 * Relative blend weights for the matcher. Aesthetic similarity dominates;
 * structural overlap is a secondary signal; the free-form job-to-be-done signal
 * is intentionally low because `classification.intent` is noisy and is
 * fabricated on `--profile` runs (see contracts `RetrieveWeights`). The
 * `pageType` hard filter lives in the matcher, not in these weights.
 */
export const DEFAULT_RETRIEVE_WEIGHTS: RetrieveWeights = Object.freeze({
  aesthetic: 0.7,
  structural: 0.25,
  job: 0.05,
})

/**
 * The default per-run cost ceiling. Pairwise judging multiplies LLM calls, so
 * every leg is capped: at most `maxGenerationCalls` directions, at most
 * `maxJudgeCalls` total judge calls across the relative + absolute legs (each
 * pairwise comparison = both slot orders × `judgeReps`), `concurrency` in
 * flight at once. `screenThenValidate` is off by default (full reps on every
 * comparison); flip it on to contain cost on larger direction sets.
 */
const DEFAULT_ENGINE_BUDGET: EngineBudget = Object.freeze({
  maxGenerationCalls: 3,
  maxJudgeCalls: 24,
  judgeReps: 1,
  concurrency: 4,
  screenThenValidate: false,
})

/**
 * The frozen default `ReferenceGroundedConfig`. `corpusDir` is the only field an
 * operator almost always overrides; the rest are tuned for the offline/text
 * default path (deterministic hash embedder, text judge) so a run works with
 * zero API key and zero network.
 */
export const DEFAULT_REFERENCE_CONFIG: ReferenceGroundedConfig = Object.freeze({
  corpusDir: 'bench/design/reference-corpus',
  artifactDir: undefined,
  k: 4,
  directionCount: 3,
  judge: 'text',
  // A single sensible default vision model ⇒ a single-judge vision run when
  // `judge: 'vision'` is selected without `--judge-models`. Ignored under the
  // default `judge: 'text'`. One ref ⇒ single judge; many ⇒ ensemble.
  visionModels: Object.freeze([{ provider: 'openai', model: 'gpt-5.4' }]) as ModelRef[],
  embedder: 'deterministic',
  budget: DEFAULT_ENGINE_BUDGET,
  reference: undefined,
  model: undefined,
})

/**
 * Deep-partial overrides for `resolveReferenceConfig`: every top-level field is
 * optional, and `budget` is itself partial so a single budget knob can be
 * overridden without restating the whole bundle.
 */
export interface ReferenceConfigOverrides
  extends Partial<Omit<ReferenceGroundedConfig, 'budget'>> {
  budget?: Partial<EngineBudget>
}

/**
 * Clamp a numeric override to a minimum, falling back to `fallback` when the
 * override is absent or non-finite (NaN/Infinity). Counts are rounded to the
 * nearest integer first so a fractional override (`k: 2.6`) resolves sensibly.
 */
function clampMin(value: number | undefined, min: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.round(value))
}

/**
 * Resolve operator overrides onto the frozen defaults: a field-by-field merge
 * with the count knobs clamped to their minimums. Always returns a fresh,
 * mutable config (the frozen defaults are never handed out directly), so callers
 * that attach a resolved `reference` later don't mutate the shared default.
 */
export function resolveReferenceConfig(
  partial: ReferenceConfigOverrides = {},
): ReferenceGroundedConfig {
  const base = DEFAULT_REFERENCE_CONFIG
  const b = partial.budget ?? {}
  const budget: EngineBudget = {
    maxGenerationCalls: clampMin(b.maxGenerationCalls, 1, base.budget.maxGenerationCalls),
    maxJudgeCalls: clampMin(b.maxJudgeCalls, 1, base.budget.maxJudgeCalls),
    judgeReps: clampMin(b.judgeReps, 1, base.budget.judgeReps),
    concurrency: clampMin(b.concurrency, 1, base.budget.concurrency),
    screenThenValidate: b.screenThenValidate ?? base.budget.screenThenValidate,
  }
  return {
    corpusDir: partial.corpusDir ?? base.corpusDir,
    artifactDir: partial.artifactDir ?? base.artifactDir,
    k: clampMin(partial.k, 1, base.k),
    directionCount: clampMin(partial.directionCount, 1, base.directionCount),
    judge: partial.judge ?? base.judge,
    visionModels: partial.visionModels ?? base.visionModels,
    embedder: partial.embedder ?? base.embedder,
    budget,
    reference: partial.reference ?? base.reference,
    model: partial.model ?? base.model,
  }
}
