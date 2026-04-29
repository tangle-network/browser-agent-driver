/**
 * Shared types for the design-audit GEPA harness.
 *
 * The harness has three layers of identity:
 *   1. FixtureCase — a page (URL or local file) plus the findings the auditor
 *      MUST surface to be considered correct.
 *   2. PromptVariant — a candidate value for a single GEPA target (e.g. an
 *      alternative `pass-focus` instruction). One target evolves at a time.
 *   3. TrialResult — one (variant, fixture) pair with the audit outcome and
 *      the metrics derived from it.
 *
 * Fixtures and targets are both versioned via SHA-256 prefix so a rollup can
 * answer "did this run use the same fixtures as that one?".
 */

import type { DesignFinding } from '../../../src/design/audit/types.js'

export type FixtureSourceType = 'url' | 'file'

export interface FixtureCase {
  id: string
  name: string
  source: { type: FixtureSourceType; target: string }
  /** Hint for the auto-classifier — the GEPA loop can pin this if needed. */
  profile?: string
  goldenFindings: GoldenFinding[]
  /** Optional soft band — the audit score should land here. Used for stability checks. */
  expectedScoreRange?: { min: number; max: number }
  /** Free-form notes — included in reports for triage. */
  notes?: string
}

export type GoldenCategory =
  | 'product'
  | 'visual'
  | 'trust'
  | 'workflow'
  | 'content'
  | 'a11y'
  | 'spacing'
  | 'typography'

export interface GoldenFinding {
  id: string
  category: GoldenCategory
  /** Severity the golden EXPECTS. Used to weight recall — missing a `critical` is worse than a `minor`. */
  severity: 'critical' | 'major' | 'minor'
  /**
   * Match phrases — case-insensitive substring match against the finding's
   * description+location. Hit on ANY of these counts as a match. Keep these
   * SHORT (3-6 words) and SPECIFIC (concrete to the defect).
   */
  any: string[]
  /** Optional regex anchors for matching. Falls back to `any` if both are set. */
  anyRegex?: string[]
  /** Hint for human reviewers explaining what the auditor SHOULD see. */
  hint: string
}

export type GepaTargetId =
  | 'pass-focus'
  | 'few-shot-example'
  | 'no-bs-rules'
  | 'conservative-score-weights'
  | 'infer-audit-mode'
  | 'pass-selection-per-classification'
  | 'patch-synthesis-signature'

export interface PromptVariant {
  id: string
  /** Logical group — what is being mutated. */
  target: GepaTargetId
  /** Stable hash of the variant payload. */
  hash: string
  /**
   * Variant payload — interpretation depends on `target`:
   *   - 'pass-focus':                    Record<AuditPassId, { goal, instructions }>
   *   - 'few-shot-example':              { example: string }
   *   - 'no-bs-rules':                   { rules: string[] }
   *   - 'conservative-score-weights':    { minWeight: number; meanWeight: number }
   *   - 'infer-audit-mode':              Record<modeKey, string>
   *   - 'pass-selection-per-classification':  Record<pageType, AuditPassId[]>
   */
  payload: unknown
  /** Human label for reports. */
  label: string
  /** Generation index (0 = seed, then 1, 2, ...). */
  generation: number
  /** Parent variant id when produced via mutation; absent for seeds. */
  parentId?: string
  /** What the mutator was trying to accomplish. */
  rationale?: string
}

export interface TrialResult {
  variantId: string
  fixtureId: string
  /** A separate audit invocation per rep — used to compute stability. */
  rep: number
  ok: boolean
  /** Overall audit score (1-10). */
  score: number
  findings: DesignFinding[]
  /** Whether each golden finding was matched. Same order as fixture.goldenFindings. */
  goldenMatches: boolean[]
  /** Token cost when available (provider-dependent). */
  tokensUsed: number
  durationMs: number
  /** Findings emitted per pass; only populated when --audit-passes runs >1 pass. */
  passFindings?: Array<{ pass: string; findings: DesignFinding[] }>
  /** Patch-generation metrics. Populated only for patch-synthesis GEPA target. */
  patchMetrics?: {
    eligibleFindings: number
    rawPatches: number
    validPatches: number
    coverage: number
    validRate: number
  }
  error?: string
}

/** Per-(variant, fixture) aggregation across reps. */
export interface FixtureSummary {
  variantId: string
  fixtureId: string
  recall: number
  precision: number
  meanScore: number
  scoreStdDev: number
  meanCost: number
  meanDurationMs: number
  okRate: number
  /** Cosine similarity between findings across passes; undefined when only one pass ran. */
  passOrthogonality?: number
  /** Mean patch-generation metrics when evaluating the patch-synthesis target. */
  patchMetrics?: {
    eligibleFindings: number
    rawPatches: number
    validPatches: number
    coverage: number
    validRate: number
  }
  trials: number
}

/** Aggregation across all fixtures for one variant. */
export interface VariantSummary {
  variantId: string
  recall: number
  precision: number
  meanScore: number
  meanCost: number
  meanDurationMs: number
  scoreStdDev: number
  passOrthogonality: number
  fixtures: FixtureSummary[]
}

/** Multi-objective vector; readers minimise/maximise per the directions table in metrics.ts. */
export interface ObjectiveVector {
  recall: number
  precision: number
  passOrthogonality: number
  scoreStability: number
  cost: number
}
