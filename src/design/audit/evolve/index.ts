/**
 * Evolve subsystem — closed-loop fix → re-audit for the `bad design-audit`
 * command. Two modes: ephemeral CSS injection (`runEvolveLoop`) and
 * agent-dispatched source edits (`runAgentEvolveLoop`), plus the shared
 * evolve report renderer and the reference-grounded options bundle that
 * threads through every re-audit call site.
 */

export { runEvolveLoop } from './css.js'
export { runAgentEvolveLoop } from './agent.js'
export { generateEvolveReport } from './report.js'
export type { ReferenceCommonOpts } from './types.js'
