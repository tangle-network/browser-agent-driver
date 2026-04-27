/**
 * Layer 5 — Pattern matching.
 *
 * Fuzzy-matches a page against catalogued patterns. When patterns exist (post
 * fleet accumulation), findings include `matchedPatterns[]` so agents can cite
 * fleet evidence rather than applying novel patches.
 *
 * Currently returns [] (cold-start). The interface is stable.
 */

import type { Pattern, PatternMatch, PatternQuery } from './types.js'
import type { PageType, Dimension } from '../score-types.js'
import { queryPatterns } from './store.js'

export interface MatchContext {
  pageType: PageType
  weakDimensions: Dimension[]
  dir?: string
}

/**
 * Match patterns against the current page context. Returns the top-N matches
 * ordered by expected leverage (weakest dim × pattern's median delta for that dim).
 *
 * Cold-start: returns [] until patterns are mined.
 */
export async function matchPatterns(
  ctx: MatchContext,
  topN: number = 5,
): Promise<PatternMatch[]> {
  const query: PatternQuery = {
    pageType: ctx.pageType,
    minApplications: 5,
    minSuccessRate: 0.5,
  }
  const candidates = await queryPatterns(query, ctx.dir)
  if (candidates.length === 0) return []

  const scored: Array<{ pattern: Pattern; leverage: number }> = candidates.map(p => {
    const leverage = ctx.weakDimensions.reduce((sum, dim) => {
      return sum + (p.fleetEvidence.medianDimDelta[dim] ?? 0)
    }, 0)
    return { pattern: p, leverage }
  })

  return scored
    .sort((a, b) => b.leverage - a.leverage)
    .slice(0, topN)
    .map(({ pattern, leverage }) => {
      const expectedDelta: Record<Dimension, number> = {} as Record<Dimension, number>
      for (const dim of ctx.weakDimensions) {
        expectedDelta[dim] = pattern.fleetEvidence.medianDimDelta[dim] ?? 0
      }
      return {
        pattern,
        matchConfidence: Math.min(1, leverage / 10),
        expectedDelta,
        applicationGuidance: `Apply ${pattern.scaffold.description}. Key decisions: ${pattern.scaffold.keyDecisions.join('; ')}.`,
      }
    })
}
