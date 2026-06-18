/**
 * Reference-grounded redesign generator — the LLM ADAPTER of the generative
 * layer. Implements the `RedesignGenerator` contract.
 *
 * Responsibility is thin: for the top `count` retrieved exemplars it fans out
 * one model call each (built by the pure `buildDirectionPrompt`), parses every
 * response with the pure fail-closed `parseDirection`, streams each accepted
 * direction through `onDirection`, and returns the directions in stable slot
 * order. All grounding/prompt/parse decisions live in the pure cores; this file
 * owns only the IO orchestration.
 *
 * Dependency injection: the model is supplied as a narrow `GenerationModel`
 * callable, so the real `Brain` (which structurally satisfies it) is wired at
 * the composition root while tests inject a deterministic mock — no model id is
 * hard-coded here.
 *
 * Fan-out width is the direction `count` (2-3, budget-capped upstream by
 * `engine/budget.planJudgeBudget`/`config.directionCount`), so the calls run
 * fully in parallel via `Promise.allSettled` — no separate concurrency limiter
 * is needed at this small, bounded width. A single failed or malformed call is
 * dropped, never fatal and never fabricated.
 */

import type {
  RedesignGenerator,
  RedesignDirection,
  GenerationContext,
  RetrievalResult,
} from '../contracts.js'
import { buildDirectionPrompt } from './prompt.js'
import { parseDirection } from './parse.js'

/**
 * The narrow model boundary this adapter depends on — exactly `Brain.complete`'s
 * shape, so the concrete `Brain` is assignable and a stub is trivial to inject.
 */
export interface GenerationModel {
  complete(
    system: string,
    user: string,
    options?: { maxOutputTokens?: number },
  ): Promise<{ text: string; tokensUsed?: number }>
}

/** Construction-time defaults for the generator adapter. */
export interface BrainGeneratorOptions {
  /** Default direction count when `generate` is called without one. */
  count?: number
  /** Output-token cap per generation call (a full direction is large). */
  maxOutputTokens?: number
  /** Forwarded to `buildDirectionPrompt` to bound injected DNA. */
  maxRefChars?: number
}

const DEFAULT_MAX_OUTPUT_TOKENS = 2200

const clampCount = (requested: number, available: number): number =>
  Math.max(0, Math.min(Math.floor(requested), available))

async function generateOne(
  model: GenerationModel,
  ctx: GenerationContext,
  hit: RetrievalResult,
  slot: number,
  allowedIds: string[],
  opts: BrainGeneratorOptions,
  reasons: string[],
  onDirection?: (d: RedesignDirection) => void,
): Promise<RedesignDirection | null> {
  try {
    const { system, user } = buildDirectionPrompt(ctx, hit, { maxRefChars: opts.maxRefChars })
    const { text } = await model.complete(system, user, {
      maxOutputTokens: opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    })
    const parsed = parseDirection(text, allowedIds)
    if (!parsed.ok) {
      reasons.push(`slot ${slot} parse failed (len=${text.length})`)
      if (process.env.BAD_DEBUG_REFGEN)
        console.error(`[refgen] slot ${slot} parse failed: ${JSON.stringify(parsed)} | len=${text.length} head=${JSON.stringify(text.slice(0, 240))}`)
      return null
    }
    // Normalise the id to a deterministic, collision-free slot id — parallel
    // calls share a prompt skeleton and may echo the same example id. The
    // model's evocative `name` and grounding are preserved.
    const direction: RedesignDirection = { ...parsed.direction, id: `direction-${slot + 1}` }
    onDirection?.(direction)
    return direction
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    reasons.push(`slot ${slot} call failed: ${message}`)
    if (process.env.BAD_DEBUG_REFGEN) console.error(`[refgen] slot ${slot} call failed: ${message}`)
    return null
  }
}

/**
 * Build a `RedesignGenerator` backed by an injected `GenerationModel`.
 */
export function createBrainGenerator(
  brain: GenerationModel,
  opts: BrainGeneratorOptions = {},
): RedesignGenerator {
  return {
    async generate(
      ctx: GenerationContext,
      exemplars: RetrievalResult[],
      genOpts?: { count?: number; onDirection?: (d: RedesignDirection) => void },
    ): Promise<RedesignDirection[]> {
      const count = clampCount(genOpts?.count ?? opts.count ?? exemplars.length, exemplars.length)
      const selected = exemplars.slice(0, count)
      // Grounding is validated against the FULL retrieved set, so a direction may
      // legitimately cite any retrieved exemplar, not only the one it was seeded
      // with.
      const allowedIds = exemplars.map((r) => r.exemplar.id)

      // Per-call failure reasons collected here so a total wipeout reports WHY
      // (e.g. an auth error) instead of a silent empty result downstream.
      const reasons: string[] = []
      const settled = await Promise.allSettled(
        selected.map((hit, slot) =>
          generateOne(brain, ctx, hit, slot, allowedIds, opts, reasons, genOpts?.onDirection),
        ),
      )

      // Stable slot order; dropped (errored/rejected) calls simply leave a gap.
      const directions: RedesignDirection[] = []
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) directions.push(r.value)
      }
      if (directions.length === 0 && selected.length > 0 && reasons.length > 0) {
        console.warn(
          `[reference] all ${selected.length} redesign generation call(s) failed — first reason: ${reasons[0]}`,
        )
      }
      return directions
    },
  }
}
