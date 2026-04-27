/**
 * Scorecard envelope for the design-audit eval.
 *
 * Three independently-meaningful flows: calibration / reproducibility / patches.
 * Each flow emits a `score`, a `target`, and a `status` (pass / fail / unmeasured).
 *
 * Pure shape — runner.ts produces these, scorecard-writer.ts persists.
 */

export type FlowStatus = 'pass' | 'fail' | 'unmeasured'

export interface FlowEnvelope {
  name: string
  description: string
  /** Numeric score the flow produces. NaN when status is unmeasured. */
  score: number
  /** Threshold that defines pass/fail. Direction (higher-is-better vs lower-is-better) is encoded in `comparator`. */
  target: number
  comparator: '>=' | '<='
  status: FlowStatus
  /** Why the status is what it is — operator-readable. */
  notes: string
  /** Link to the artifact (results dir / report) for drilldown. */
  artifact?: string
  /** Cost in USD if measurable. */
  costUSD?: number
  /** Per-site / per-rep details, when relevant. */
  detail?: Record<string, unknown>
}

export interface DesignAuditScorecard {
  product: 'browser-agent-driver'
  track: 'track-2-design-audit'
  generation: number
  timestamp: string
  /** All flows that ran in this measurement pass. */
  flows: FlowEnvelope[]
  /** Top-level summary so a glance shows pass/total. */
  summary: { pass: number; total: number; unmeasured: number }
}

export function emptyScorecard(generation: number): DesignAuditScorecard {
  return {
    product: 'browser-agent-driver',
    track: 'track-2-design-audit',
    generation,
    timestamp: new Date().toISOString(),
    flows: [],
    summary: { pass: 0, total: 0, unmeasured: 0 },
  }
}

export function summarize(flows: FlowEnvelope[]): DesignAuditScorecard['summary'] {
  return {
    pass: flows.filter(f => f.status === 'pass').length,
    total: flows.length,
    unmeasured: flows.filter(f => f.status === 'unmeasured').length,
  }
}

export function statusFor(score: number, target: number, comparator: '>=' | '<='): FlowStatus {
  if (!Number.isFinite(score)) return 'unmeasured'
  return comparator === '>=' ? (score >= target ? 'pass' : 'fail') : (score <= target ? 'pass' : 'fail')
}
