/**
 * LLM narration around deterministic data.
 *
 * The contract: numbers come from the templates (which call the aggregate
 * functions). The LLM only writes prose context — top-line takeaways, an
 * angle on what's surprising. Same pattern as the patches contract.
 *
 * If a Brain isn't supplied, the deterministic markdown is returned as-is.
 * That's the safe default — never silently fabricate prose.
 */

import type { Brain } from '../brain/index.js'

const SYSTEM = `You are an analyst writing a one-paragraph executive summary at the top of a design-audit report.

Rules:
- Use ONLY the numbers and facts in the provided markdown report. Do not invent rankings, scores, or claims.
- Surface the most surprising or load-bearing finding (e.g. a tier-vs-tier gap, a dramatic longitudinal swing, an outlier).
- Two to four sentences. No bullet lists.
- Do not preface with "Here is your summary" or similar.`

export interface NarrateOptions {
  /** When supplied, prepends an LLM-written executive summary above the deterministic body. */
  brain?: Brain
  /** Free-form context passed to the LLM (e.g. "this is the YC W25 cohort"). */
  context?: string
}

export async function narrateReport(deterministicMarkdown: string, opts: NarrateOptions = {}): Promise<string> {
  if (!opts.brain) return deterministicMarkdown
  const user = [
    opts.context ? `Context: ${opts.context}` : undefined,
    'REPORT:',
    deterministicMarkdown,
    '',
    'Write the executive summary now.',
  ].filter(Boolean).join('\n\n')
  try {
    const { text } = await opts.brain.complete(SYSTEM, user, { maxOutputTokens: 320 })
    const summary = text.trim()
    if (!summary) return deterministicMarkdown
    return `## Executive summary\n\n${summary}\n\n${deterministicMarkdown}`
  } catch {
    // Don't let narration failures block the artifact. Ship the data.
    return deterministicMarkdown
  }
}
