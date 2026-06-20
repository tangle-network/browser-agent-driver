/**
 * Pairwise taste evaluator: does the taste judge agree with the corpus
 * ground-truth ordering? A `FlowEnvelope` sibling of `calibration.ts`.
 *
 * Ground truth: a set of `TastePair`s (known-stronger vs known-weaker exemplar).
 * The evaluator runs each pair through the position-debiased `judgePair` (both
 * slot orders, reconciled), then asks `eval/taste-core.tasteAgreement` what
 * fraction of pairs the judge ordered correctly. The win-rate CI is the shared
 * `wilsonInterval` from `scripts/lib/stats.mjs` — never re-implemented here.
 *
 * The judge is INJECTED (`TasteJudge`), so this helper drives the shipped text
 * judge in production and a deterministic stub in tests; it issues no live model
 * call of its own. Concurrency, debiasing, agreement, and reference metrics are
 * all delegated to the already-built engine cores — this file is wiring only.
 */

import { judgePair } from '../../../src/design/audit/reference/judge/pairwise.js'
import { mapWithConcurrency } from '../../../src/design/audit/reference/engine/budget.js'
import {
  tasteAgreement,
  tasteMetricsFromVerdicts,
} from '../../../src/design/audit/reference/eval/taste-core.js'
import type {
  JudgePairInput,
  JudgeSubject,
  ReferenceContext,
  TasteAgreementResult,
  TasteJudge,
  TasteMetrics,
  TastePair,
  TasteVerdict,
} from '../../../src/design/audit/reference/contracts.js'
import type { FlowEnvelope } from './scorecard.js'
import { statusFor } from './scorecard.js'
// Shared statistical primitives — CIs are never hand-rolled at this layer.
import { wilsonInterval } from '../../../scripts/lib/stats.mjs'

const FLOW_NAME = 'designAudit_taste_pairwise_agreement_rate'

export interface TastePairwiseOptions {
  /** Comparison subjects keyed by exemplar id (DNA summaries the judge reads). */
  subjects: Record<string, JudgeSubject>
  /** Labelled corpus pairs: each names the known-stronger and known-weaker id. */
  pairs: TastePair[]
  /** Injected judge — the shipped text judge in prod, a stub in tests. */
  judge: TasteJudge
  /** Optional reference threaded into every comparison. */
  reference?: ReferenceContext
  /** Repetitions per comparison (each rep = both slot orders). Default 1. */
  reps?: number
  /** Max concurrent in-flight comparisons. Default 4. */
  concurrency?: number
  /** Pass threshold for the agreement rate. Default 0.7. */
  target?: number
  /**
   * When set, also computes generated-vs-reference `TasteMetrics` over the same
   * verdict set (for the GEPA taste objective branch).
   */
  referenceId?: string
}

export interface TastePairwiseResult {
  flow: FlowEnvelope
  agreement: TasteAgreementResult
  verdicts: TasteVerdict[]
  metrics?: TasteMetrics
}

/**
 * Judge every labelled pair (position-debiased), score agreement against the
 * corpus order, and emit one `FlowEnvelope`. Pairs missing a subject are skipped
 * and reported in `notes` — never silently treated as agreement. With no
 * decisive comparisons the flow score is `NaN` ⇒ `unmeasured`, so an empty run
 * can never look like a pass.
 */
export async function evaluateTastePairwise(opts: TastePairwiseOptions): Promise<TastePairwiseResult> {
  const target = opts.target ?? 0.7
  const reps = opts.reps ?? 1
  const concurrency = opts.concurrency ?? 4

  const judgeable = opts.pairs.filter((p) => opts.subjects[p.strongId] && opts.subjects[p.weakId])

  const verdicts = await mapWithConcurrency(judgeable, concurrency, async (pair) => {
    const input: JudgePairInput = {
      a: opts.subjects[pair.strongId],
      b: opts.subjects[pair.weakId],
      ...(opts.reference ? { reference: opts.reference } : {}),
    }
    return judgePair(opts.judge, input, reps)
  })

  const agreement = tasteAgreement(opts.pairs, verdicts)
  const successes = Math.round(agreement.agreementRate * agreement.n)
  const [lo, hi] = wilsonInterval(successes, agreement.n) as [number, number]
  const score = agreement.n > 0 ? agreement.agreementRate : NaN
  const metrics = opts.referenceId ? tasteMetricsFromVerdicts(opts.referenceId, verdicts) : undefined
  const skipped = opts.pairs.length - judgeable.length

  const flow: FlowEnvelope = {
    name: FLOW_NAME,
    description:
      'Fraction of labelled corpus taste-pairs the position-debiased judge ordered correctly (stronger exemplar preferred).',
    score,
    target,
    comparator: '>=',
    status: statusFor(score, target, '>='),
    notes: `${successes}/${agreement.n} pairs agree; 95% Wilson CI [${lo.toFixed(2)}, ${hi.toFixed(2)}]; ${skipped} pairs skipped (missing subject)`,
    detail: { agreement, ci: [lo, hi], reps, ...(metrics ? { metrics } : {}) },
  }

  return { flow, agreement, verdicts, ...(metrics ? { metrics } : {}) }
}
