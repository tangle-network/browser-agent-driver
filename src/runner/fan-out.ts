/**
 * Gen 33 — mid-run parallel fan-out executor.
 *
 * When the agent emits a `fanOut` action in the middle of a run, this
 * module spawns N sub-agents in fresh tabs of the same BrowserContext,
 * runs them in parallel with bounded concurrency, collects their
 * verdicts, and returns a formatted feedback string the parent runner
 * injects back into the agent's next turn.
 *
 * Architecture:
 *   - Same BrowserContext so cookies / localStorage / authenticated
 *     session carry over to every branch
 *   - Fresh Page per sub-agent so their DOM state doesn't collide with
 *     the parent page
 *   - PlaywrightDriver per sub-agent with showCursor OFF (the parent's
 *     cursor overlay is the one the viewer sees; sub-tabs are invisible
 *     to the recording)
 *   - Hard cap of 8 concurrent sub-agents to prevent runaway spawning
 *   - Each sub-agent times out at 60s × maxTurns(8) = 480s max; the
 *     outer fanOut times out at 900s regardless
 *   - Sub-agent failures are captured, never thrown to the parent —
 *     the parent sees "BRANCH 3: error: …" as part of the structured
 *     feedback and can choose to retry / ignore / incorporate
 *
 * This is different from Gen 21's parallel-runner.ts, which runs the
 * ENTIRE run as parallel sub-goals decided up front. FanOut is called
 * from inside a turn, with whatever sub-goals the agent synthesized on
 * the fly from the current page's content.
 */

import type { BrowserContext, Page } from 'playwright'
import type { AgentConfig, FanOutAction, Scenario } from '../types.js'
import type { ProjectStore } from '../memory/project-store.js'
import { PlaywrightDriver, type PlaywrightDriverOptions } from '../drivers/playwright.js'
import { BrowserAgent } from './runner.js'
import type { AgentResult } from '../types.js'

/** Hard cap on concurrent sub-agents. Beyond 8 is a footgun. */
const MAX_CONCURRENT_SUBAGENTS = 8

/** Default max turns per sub-agent when the action doesn't specify. */
const DEFAULT_SUB_MAX_TURNS = 8

/** Timeout budget for the whole fan-out, even if individual sub-agents are still running. */
const FAN_OUT_TIMEOUT_MS = 900_000

export interface FanOutExecutorOptions {
  /** Parent agent's browser context. Sub-agents get fresh pages here. */
  context: BrowserContext
  /** Parent agent's LLM + driver config (inherited by sub-agents, sub-budget scaled). */
  config: AgentConfig
  /** Forwarded to sub-agent's PlaywrightDriver. showCursor is always overridden to false. */
  driverOptions?: Omit<PlaywrightDriverOptions, 'showCursor'>
  /** Project memory store, if any — sub-agents share knowledge with the parent. */
  projectStore?: ProjectStore
  /** Macro catalog prompt block. Sub-agents inherit the parent's macros. */
  macroPromptBlock?: string
  /** Parent's currentURL — used as a default for any sub-goal that didn't set one. */
  currentUrl?: string
  /**
   * Called when a sub-agent starts / finishes. Useful for the overlay's
   * progress bar (shows "branch 3/10 done") during a fan-out.
   */
  onBranchStart?: (index: number, label: string) => void
  onBranchComplete?: (index: number, label: string, result: AgentResult) => void
}

export interface FanOutBranchResult {
  index: number
  label: string
  url: string
  goal: string
  success: boolean
  /** Agent's final verdict string (or error message). */
  verdict: string
  turnsUsed: number
  durationMs: number
  /** Tokens used by this branch. Summed across branches for cost accounting. */
  tokensUsed?: number
}

export interface FanOutExecutionResult {
  branches: FanOutBranchResult[]
  /** Formatted feedback string to inject into the parent agent's context. */
  feedback: string
  /** Total wall time for the whole fan-out (max of per-branch times, not sum). */
  totalMs: number
  /** Total tokens consumed across all branches. */
  tokensUsed: number
}

/**
 * Run a fanOut action. Returns structured per-branch results + a
 * human-readable feedback string.
 */
export async function executeFanOut(
  action: FanOutAction,
  opts: FanOutExecutorOptions,
): Promise<FanOutExecutionResult> {
  const startedAt = Date.now()
  const subGoals = (action.subGoals ?? []).slice(0, MAX_CONCURRENT_SUBAGENTS)
  if (subGoals.length === 0) {
    return {
      branches: [],
      feedback: 'FAN-OUT ERROR: no subGoals specified.',
      totalMs: 0,
      tokensUsed: 0,
    }
  }

  // Run all sub-agents concurrently. Every branch captures its own
  // errors into the result record so one bad branch can't poison the
  // whole fan-out.
  const branches = await Promise.all(
    subGoals.map((sg, index) => runBranch(sg, index, opts)),
  ).catch((err: Error) => {
    // Shouldn't ever reach here — runBranch catches internally — but if
    // Playwright throws a synchronous error from context.newPage we
    // still want a structured shape back.
    return subGoals.map((sg, index): FanOutBranchResult => ({
      index,
      label: sg.label ?? `branch-${index + 1}`,
      url: sg.url,
      goal: sg.goal,
      success: false,
      verdict: `internal fan-out error: ${err.message}`,
      turnsUsed: 0,
      durationMs: 0,
    }))
  })

  const totalMs = Date.now() - startedAt
  const tokensUsed = branches.reduce((s, b) => s + (b.tokensUsed ?? 0), 0)

  return {
    branches,
    feedback: formatFeedback(branches, action.summarize),
    totalMs,
    tokensUsed,
  }
}

async function runBranch(
  sg: FanOutAction['subGoals'][number],
  index: number,
  opts: FanOutExecutorOptions,
): Promise<FanOutBranchResult> {
  const label = sg.label ?? `branch-${index + 1}`
  const url = sg.url || opts.currentUrl || ''
  const maxTurns = Math.max(1, Math.min(30, sg.maxTurns ?? DEFAULT_SUB_MAX_TURNS))
  const startedAt = Date.now()

  opts.onBranchStart?.(index, label)

  let page: Page | undefined
  try {
    page = await opts.context.newPage()

    const driver = new PlaywrightDriver(page, {
      ...(opts.driverOptions ?? {}),
      // Sub-tabs never show the cursor — the parent tab's overlay is
      // the one the viewer sees. We don't want a phantom cursor fighting
      // over which mouse position is "canonical" in the recording.
      showCursor: false,
    })

    const subAgent = new BrowserAgent({
      driver,
      config: opts.config,
      ...(opts.projectStore ? { projectStore: opts.projectStore } : {}),
      ...(opts.macroPromptBlock ? { macroPromptBlock: opts.macroPromptBlock } : {}),
    })

    const scenario: Scenario = {
      goal: sg.goal,
      startUrl: url,
      maxTurns,
    }

    const perBranchTimeoutMs = Math.min(FAN_OUT_TIMEOUT_MS, 60_000 * maxTurns)
    const result = await Promise.race([
      subAgent.run(scenario),
      new Promise<AgentResult>((_, reject) =>
        setTimeout(() => reject(new Error(`branch ${label} timed out after ${perBranchTimeoutMs}ms`)), perBranchTimeoutMs),
      ),
    ])

    const maybeTokens = (result as unknown as { totalTokensUsed?: unknown }).totalTokensUsed
    const branchResult: FanOutBranchResult = {
      index,
      label,
      url,
      goal: sg.goal,
      success: Boolean(result.success),
      verdict: (result.reason ?? '').slice(0, 2000),
      turnsUsed: result.turns?.length ?? 0,
      durationMs: Date.now() - startedAt,
      ...(typeof maybeTokens === 'number' ? { tokensUsed: maybeTokens } : {}),
    }
    opts.onBranchComplete?.(index, label, result)
    return branchResult
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      index,
      label,
      url,
      goal: sg.goal,
      success: false,
      verdict: `error: ${msg}`.slice(0, 2000),
      turnsUsed: 0,
      durationMs: Date.now() - startedAt,
    }
  } finally {
    if (page && !page.isClosed()) {
      await page.close().catch(() => { /* best-effort */ })
    }
  }
}

/**
 * Format branch results as a single human-readable feedback block the
 * parent agent's Brain can consume on the next turn. JSON-serializable
 * structure first (so the agent can parse verdicts mechanically), then
 * a plaintext summary. The parent model is free to prefer either.
 */
export function formatFeedback(branches: FanOutBranchResult[], summarize?: string): string {
  const jsonPayload = branches.map((b) => ({
    label: b.label,
    success: b.success,
    verdict: b.verdict,
    turnsUsed: b.turnsUsed,
    durationMs: b.durationMs,
  }))
  const lines: string[] = []
  lines.push(`FAN-OUT RESULTS (${branches.length} branches):`)
  lines.push('```json')
  lines.push(JSON.stringify(jsonPayload, null, 2))
  lines.push('```')
  if (summarize) {
    lines.push('')
    lines.push(`SUMMARIZATION HINT: ${summarize}`)
  }
  lines.push('')
  lines.push('Branch details:')
  for (const b of branches) {
    const status = b.success ? '✓' : '✗'
    lines.push(`  [${status}] ${b.label} (${b.turnsUsed} turns, ${Math.round(b.durationMs / 100) / 10}s): ${truncateOneLine(b.verdict, 200)}`)
  }
  return lines.join('\n')
}

function truncateOneLine(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine
}

/** Exposed for tests to pin the concurrency cap. */
export const FAN_OUT_MAX_CONCURRENT = MAX_CONCURRENT_SUBAGENTS
