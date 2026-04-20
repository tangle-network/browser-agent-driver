/**
 * Parallel Runner — executes compound goals across multiple browser tabs.
 *
 * Gen 21: takes decomposed sub-goals from GoalDecomposer, creates one
 * BrowserAgent per sub-goal in separate Pages (shared BrowserContext),
 * runs them concurrently, and merges results via EvidenceMerger.
 *
 * Uses the same PlaywrightDriver + BrowserAgent stack as single-page runs.
 * The parallel execution layer is thin — the intelligence is in the
 * GoalDecomposer (split) and EvidenceMerger (combine).
 */

import type { BrowserContext } from 'playwright'
import { PlaywrightDriver } from '../drivers/playwright.js'
import type { PlaywrightDriverOptions } from '../drivers/playwright.js'
import { BrowserAgent } from './runner.js'
import type { Scenario, AgentConfig, AgentResult, Turn } from '../types.js'
import type { SubGoal } from './goal-decomposer.js'
import type { ProjectStore } from '../memory/project-store.js'

export interface ParallelRunOptions {
  /** Browser context to create new pages in */
  context: BrowserContext
  /** Agent config (shared across sub-agents) */
  config: AgentConfig
  /** The original compound goal */
  originalGoal: string
  /** Decomposed sub-goals */
  subGoals: SubGoal[]
  /** Original scenario (for timeout, memory, etc.) */
  scenario: Scenario
  /** Per-turn callback with sub-agent label */
  onTurn?: (label: string, turn: Turn) => void
  /** Driver options */
  driverOptions?: PlaywrightDriverOptions
  /** Project store for memory */
  projectStore?: ProjectStore
  /** Gen 29: rendered macro catalog forwarded to each sub-agent's brain so
   * the LLM sees the available macros in parallel tabs, matching the
   * top-level agent's capability surface. */
  macroPromptBlock?: string
  /** Total timeout in ms (default: 600000) */
  timeoutMs?: number
  /** Total token budget (will be split across sub-agents) */
  totalTokenBudget?: number
}

export interface ParallelRunResult {
  /** Merged final result text */
  mergedResult: string
  /** Whether the overall goal was achieved */
  success: boolean
  /** Per-sub-agent results */
  subResults: Array<{
    subGoal: SubGoal
    result: AgentResult
  }>
  /** Total tokens across all sub-agents */
  totalTokens: number
  /** Total wall time */
  totalMs: number
}

/**
 * Run sub-goals in parallel across separate browser tabs.
 *
 * Creates one Page + PlaywrightDriver + BrowserAgent per sub-goal,
 * runs them concurrently with per-agent timeouts, and collects results.
 */
export async function runParallel(options: ParallelRunOptions): Promise<ParallelRunResult> {
  const startTime = Date.now()
  const { context, config, subGoals, scenario, onTurn } = options

  // Per-sub-agent timeout: split the total timeout proportionally
  const totalTimeout = options.timeoutMs || 600_000
  const perAgentTimeout = Math.floor(totalTimeout * 0.85) // 85% of total, leave room for merge

  // Create and run sub-agents in parallel
  const subPromises = subGoals.map(async (subGoal, index) => {
    const label = `sub-${index}`
    let page: import('playwright').Page | undefined

    try {
      page = await context.newPage()

      const driver = new PlaywrightDriver(page, {
        ...options.driverOptions,
        showCursor: false, // no cursor overlay on parallel tabs
      })

      // Set up resource blocking if configured
      const blocking = (config as { resourceBlocking?: import('../drivers/types.js').ResourceBlockingOptions }).resourceBlocking
      if (blocking) {
        await driver.setupResourceBlocking(blocking)
      }

      const subConfig: AgentConfig = {
        ...config,
        // Scale token budget by sub-goal's budget fraction
        tokenBudget: options.totalTokenBudget
          ? Math.floor(options.totalTokenBudget * subGoal.budgetFraction)
          : undefined,
      }

      const agent = new BrowserAgent({
        driver,
        config: subConfig,
        onTurn: onTurn ? (turn: Turn) => onTurn(label, turn) : undefined,
        projectStore: options.projectStore,
        // extensions passed through if available
        ...(options.macroPromptBlock ? { macroPromptBlock: options.macroPromptBlock } : {}),
      })

      const subScenario: Scenario = {
        ...scenario,
        goal: subGoal.goal,
        startUrl: subGoal.startUrl || scenario.startUrl,
        // Scale max turns by budget fraction
        maxTurns: Math.max(10, Math.floor((scenario.maxTurns || 30) * subGoal.budgetFraction * 1.5)),
      }

      const result = await Promise.race([
        agent.run(subScenario),
        new Promise<AgentResult>((_, reject) =>
          setTimeout(() => reject(new Error(`Sub-agent ${label} timed out`)), perAgentTimeout)
        ),
      ])

      return { subGoal, result }
    } catch (err) {
      // Sub-agent failed — return a failure result
      return {
        subGoal,
        result: {
          success: false,
          reason: `Sub-agent error: ${err instanceof Error ? err.message : String(err)}`,
          turns: [],
          totalMs: Date.now() - startTime,
        } as AgentResult,
      }
    } finally {
      // Close the page but not the context (shared with other sub-agents)
      if (page && !page.isClosed()) {
        await page.close().catch(() => {})
      }
    }
  })

  const subResults = await Promise.all(subPromises)

  // Merge results
  const mergedResult = mergeEvidence(options.originalGoal, subResults)
  const totalTokens = subResults.reduce((sum, sr) => {
    const tokens = (sr.result as { totalTokensUsed?: number }).totalTokensUsed || 0
    return sum + tokens
  }, 0)

  return {
    mergedResult: mergedResult.text,
    success: mergedResult.success,
    subResults,
    totalTokens,
    totalMs: Date.now() - startTime,
  }
}

/**
 * Merge evidence from parallel sub-agents into one coherent answer.
 *
 * For now: deterministic merge (concatenate results with labels).
 * Future: LLM-based synthesis for complex comparisons.
 */
function mergeEvidence(
  originalGoal: string,
  subResults: Array<{ subGoal: SubGoal; result: AgentResult }>,
): { text: string; success: boolean } {
  const successCount = subResults.filter(sr => sr.result.success).length
  const allSucceeded = successCount === subResults.length
  const anySucceeded = successCount > 0

  // Build merged result text
  const parts: string[] = [`Goal: ${originalGoal}`, '']

  for (const { subGoal, result } of subResults) {
    const status = result.success ? 'COMPLETED' : 'FAILED'
    parts.push(`[${status}] ${subGoal.goal}:`)
    if (result.reason) {
      parts.push(result.reason)
    }
    parts.push('')
  }

  if (!anySucceeded) {
    parts.push('None of the sub-goals could be completed.')
  } else if (!allSucceeded) {
    parts.push(`${successCount}/${subResults.length} sub-goals completed.`)
  }

  return {
    text: parts.join('\n'),
    success: anySucceeded, // succeed if at least one sub-goal worked
  }
}
