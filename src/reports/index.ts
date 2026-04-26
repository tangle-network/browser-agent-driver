/**
 * Reports — turn a job's audit results into shareable artifacts.
 *
 * Two surfaces:
 *   1. Static templates (deterministic markdown rendering — see templates.ts)
 *   2. AI SDK tools (agentic chat over the same data — see tools.ts)
 *
 * Both flow through the same aggregate.ts functions, so numbers are consistent.
 */

export type { AggregateRow, CompareRunsResult, DimensionDelta, LongitudinalRow, ReportTemplate } from './types.js'
export { aggregateJob, leaderboard, longitudinalFor, compareRuns, tierBuckets } from './aggregate.js'
export type { LeaderboardOptions, TierBucket } from './aggregate.js'
export {
  renderLeaderboard,
  renderLongitudinal,
  renderBatchComparison,
  renderJobHeader,
} from './templates.js'
export type {
  LeaderboardRenderOpts,
  LongitudinalRenderOpts,
  BatchComparisonRenderOpts,
} from './templates.js'
export { buildReportTools } from './tools.js'
export type { ReportToolsContext, ReportToolSet } from './tools.js'
export { narrateReport } from './narrate.js'
export type { NarrateOptions } from './narrate.js'
