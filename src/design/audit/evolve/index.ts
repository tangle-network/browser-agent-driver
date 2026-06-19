/**
 * Evolve subsystem — closed-loop fix → re-audit for the `bad design-audit`
 * command. Two modes: ephemeral CSS injection (`runEvolveLoop`) and
 * agent-dispatched source edits (`runAgentEvolveLoop`), plus the shared
 * evolve report renderer and the reference-grounded options bundle that
 * threads through every re-audit call site. `buildApplyPrompt` is the
 * non-spawning default: the portable prompt a coding agent runs itself.
 */

export { runEvolveLoop } from './css.js'
export { runAgentEvolveLoop, buildApplyPrompt } from './agent.js'
export { generateEvolveReport } from './report.js'
export type { ReferenceCommonOpts } from './types.js'
