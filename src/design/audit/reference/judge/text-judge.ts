/**
 * Text taste judge — the default `TasteJudge` adapter. The ONLY impure piece of
 * the judge stack: one `brain.complete` per comparison over budget-bounded DNA /
 * direction summaries, parsed by the pure `parseRawVerdict`. All debiasing,
 * aggregation, and ranking live in the pure cores around it (`pairwise`,
 * `quality`, `rank`).
 *
 * The model dependency is injected through the narrow `JudgeModel` seam — the
 * real `Brain` satisfies it structurally, so the wiring root passes `brain`
 * unchanged while unit tests inject a deterministic mock with no live model.
 *
 * `brain.auditDesign` is deliberately NOT used: overloading the page-audit seam
 * for taste comparison is the contract abuse the architecture forbids. A vision
 * judge is a future drop-in implementing this same `TasteJudge` interface once a
 * clean visual-compare seam exists.
 */

import type { JudgePairInput, RawVerdict, TasteJudge } from '../contracts.js'
import { buildPairwisePrompt, buildQualityPrompt } from './prompt.js'
import { parseRawVerdict } from './parse.js'

/**
 * The narrow model seam the text judge needs. `Brain` is assignable to this, so
 * `createTextJudge(brain)` compiles at the wiring root while tests supply a stub.
 */
export interface JudgeModel {
  complete(
    system: string,
    user: string,
    options?: { maxOutputTokens?: number },
  ): Promise<{ text: string; tokensUsed?: number }>
}

// Verdict JSON is tiny; cap output so a runaway judge response can't blow budget.
const JUDGE_MAX_OUTPUT_TOKENS = 400

export function createTextJudge(brain: JudgeModel): TasteJudge {
  return {
    id: 'text-judge',
    async compare(input: JudgePairInput): Promise<RawVerdict> {
      // Direction-vs-direction comparisons carry a directionSummary; page-vs-
      // exemplar (absolute quality) comparisons carry only DNA. Choose the
      // matching prompt; the debias core supplies the slot order via input a/b.
      const usesDirections = Boolean(input.a.directionSummary || input.b.directionSummary)
      const { system, user } = usesDirections
        ? buildPairwisePrompt(input, 'AB')
        : buildQualityPrompt(input, 'AB')

      const { text, tokensUsed } = await brain.complete(system, user, {
        maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
      })
      const verdict = parseRawVerdict(text)

      // Echo the dimension scope so the quality leg can bucket per-dimension.
      return input.dimension !== undefined
        ? { ...verdict, dimension: input.dimension, tokensUsed }
        : { ...verdict, tokensUsed }
    },
  }
}
