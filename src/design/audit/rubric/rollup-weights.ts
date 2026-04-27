/**
 * Rollup weights — Layer 1 of the world-class design-audit architecture.
 *
 * Per-page-type weights for combining the 5 dimension scores into a single
 * rollup. Marketing surfaces emphasize visual + content; saas-app surfaces
 * emphasize product_intent + workflow; docs lean on content_ia. The weights
 * are evolvable via the GEPA target `pareto-rollup-weights`.
 *
 * Invariant: every weight set sums to 1.0 within 1e-6.
 */

import type { Dimension } from '../score-types.js'
import type { PageType } from '../types.js'

export type RollupWeightKey = PageType | 'default'

const ROLLUP_WEIGHTS_RAW: Record<RollupWeightKey, Record<Dimension, number>> = {
  marketing: { product_intent: 0.30, visual_craft: 0.30, content_ia: 0.25, trust_clarity: 0.10, workflow: 0.05 },
  'saas-app': { product_intent: 0.35, workflow: 0.30, visual_craft: 0.15, trust_clarity: 0.10, content_ia: 0.10 },
  dashboard: { product_intent: 0.30, workflow: 0.30, content_ia: 0.20, visual_craft: 0.15, trust_clarity: 0.05 },
  docs: { content_ia: 0.45, workflow: 0.25, product_intent: 0.15, visual_craft: 0.15, trust_clarity: 0.0 },
  ecommerce: { trust_clarity: 0.35, product_intent: 0.30, workflow: 0.20, visual_craft: 0.10, content_ia: 0.05 },
  social: { product_intent: 0.30, workflow: 0.30, content_ia: 0.20, visual_craft: 0.15, trust_clarity: 0.05 },
  tool: { workflow: 0.40, product_intent: 0.30, content_ia: 0.15, visual_craft: 0.10, trust_clarity: 0.05 },
  blog: { content_ia: 0.50, visual_craft: 0.25, product_intent: 0.15, workflow: 0.10, trust_clarity: 0.0 },
  utility: { workflow: 0.45, product_intent: 0.25, content_ia: 0.20, visual_craft: 0.10, trust_clarity: 0.0 },
  unknown: { product_intent: 0.30, workflow: 0.25, visual_craft: 0.20, content_ia: 0.15, trust_clarity: 0.10 },
  default: { product_intent: 0.30, workflow: 0.25, visual_craft: 0.20, content_ia: 0.15, trust_clarity: 0.10 },
}

const WEIGHT_SUM_TOLERANCE = 1e-6

// Validate at module load — fail fast if a weight set drifts.
for (const [type, weights] of Object.entries(ROLLUP_WEIGHTS_RAW)) {
  const sum = Object.values(weights).reduce((acc, n) => acc + n, 0)
  if (Math.abs(sum - 1) > WEIGHT_SUM_TOLERANCE) {
    throw new Error(`rollup weights for ${type} sum to ${sum}, expected 1.0 ± ${WEIGHT_SUM_TOLERANCE}`)
  }
}

export const ROLLUP_WEIGHTS: Record<RollupWeightKey, Record<Dimension, number>> = ROLLUP_WEIGHTS_RAW

/**
 * Look up rollup weights for a page type, falling back to `default` when the
 * type isn't in the table (forward-compat for new types).
 */
export function rollupWeightsFor(type: PageType | undefined): Record<Dimension, number> {
  if (type && type in ROLLUP_WEIGHTS) return ROLLUP_WEIGHTS[type as RollupWeightKey]
  return ROLLUP_WEIGHTS.default
}

/**
 * Render a human-readable formula for the audit report, e.g.
 *   "saas-app: product_intent*0.35 + workflow*0.30 + visual_craft*0.15 + trust_clarity*0.10 + content_ia*0.10"
 */
export function rollupFormula(type: PageType | undefined, weights: Record<Dimension, number>): string {
  const entries = Object.entries(weights).sort(([, a], [, b]) => b - a)
  const body = entries.map(([dim, w]) => `${dim}*${w.toFixed(2)}`).join(' + ')
  return `${type ?? 'default'}: ${body}`
}
