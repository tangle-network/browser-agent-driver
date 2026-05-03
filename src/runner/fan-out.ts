/**
 * Mid-run parallel fan-out executor.
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
 * This differs from parallel-runner.ts, which decomposes the whole run up
 * front. FanOut is called inside a turn with sub-goals synthesized from the
 * current page's content.
 */

import type { BrowserContext, Page } from 'playwright'
import type { AgentConfig, FanOutAction, Scenario } from '../types.js'
import type { ProjectStore } from '../memory/project-store.js'
import type { Driver } from '../drivers/types.js'
import { PlaywrightDriver, type PlaywrightDriverOptions } from '../drivers/playwright.js'
import type { AgentResult } from '../types.js'

// Dynamic import of BrowserAgent breaks the runner.ts <-> fan-out.ts
// import cycle. runner.ts dynamic-imports this module; any static
// back-import (even `import type`) makes madge flag a graph cycle.
//
// The return type is a minimal structural constructor — we only need
// `new (opts)` and `.run(scenario)`. The full BrowserAgentOptions surface
// is opaque here; fan-out passes through driver + config + optional fields.
interface SubAgentRunner {
  run(scenario: import('../types.js').Scenario): Promise<AgentResult>
}
interface BrowserAgentCtor {
  new (opts: {
    driver: Driver
    config: AgentConfig
    projectStore?: ProjectStore
    macroPromptBlock?: string
  }): SubAgentRunner
}
let _BrowserAgentCtor: BrowserAgentCtor | undefined
async function getBrowserAgent(): Promise<BrowserAgentCtor> {
  if (!_BrowserAgentCtor) {
    const mod = await import('./runner.js')
    _BrowserAgentCtor = mod.BrowserAgent as unknown as BrowserAgentCtor
  }
  return _BrowserAgentCtor
}

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
   * Parent driver used to drive the fan-out overlay on the parent page.
   * Pass undefined to skip overlay updates.
   */
  parentDriver?: Driver
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
 *
 * When `parentDriver` is provided (i.e., the parent run has the cursor
 * overlay enabled), the executor also drives the Hydra View: initializes
 * the grid, streams live screenshots from each sub-tab at ~2.5 FPS,
 * completes each cell with a verdict chip, then runs the collapse/merge
 * animation before returning.
 */
/**
 * Expand the (baseUrl, goalTemplate, items) shorthand into explicit
 * subGoals. This is how a compact LLM-emitted fanOut (a few strings,
 * minimal nesting, nearly impossible to malform as JSON) becomes the
 * full subGoals[] the executor needs.
 *
 * Precedence: if `subGoals` is non-empty it wins. Otherwise, if the
 * shorthand fields are present and coherent, we expand. Otherwise we
 * return empty and the caller reports the error.
 */
export function resolveSubGoals(action: FanOutAction): FanOutAction['subGoals'] {
  if (Array.isArray(action.subGoals) && action.subGoals.length > 0) {
    return action.subGoals
  }
  const { baseUrl, goalTemplate, items } = action
  if (!baseUrl || !goalTemplate || !Array.isArray(items) || items.length === 0) {
    return undefined
  }
  return items.map((item) => ({
    url: baseUrl,
    goal: goalTemplate.replace(/\{item\}/g, item),
    label: item,
  }))
}

export async function executeFanOut(
  action: FanOutAction,
  opts: FanOutExecutorOptions,
): Promise<FanOutExecutionResult> {
  const startedAt = Date.now()
  const resolved = resolveSubGoals(action)
  const subGoals = (resolved ?? []).slice(0, MAX_CONCURRENT_SUBAGENTS)
  if (subGoals.length === 0) {
    return {
      branches: [],
      feedback: 'FAN-OUT ERROR: provide either `subGoals` array or the `baseUrl` + `goalTemplate` + `items` shorthand.',
      totalMs: 0,
      tokensUsed: 0,
    }
  }

  // Kick off the fan-out overlay on the parent page. Overlay errors are cosmetic.
  const labels = subGoals.map((sg, i) => sg.label ?? `branch-${i + 1}`)
  if (opts.parentDriver?.fanOutStart) {
    await opts.parentDriver.fanOutStart(labels).catch(() => { /* cosmetic */ })
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

  // Keep fast fan-outs visible long enough to be legible, then collapse and dismiss.
  if (opts.parentDriver?.fanOutCollapse) {
    const elapsed = Date.now() - startedAt
    if (elapsed < 3000) {
      await new Promise((r) => setTimeout(r, 3000 - elapsed))
    }
    await opts.parentDriver.fanOutCollapse().catch(() => { /* cosmetic */ })
    await new Promise((r) => setTimeout(r, 520))
  }
  if (opts.parentDriver?.fanOutDismiss) {
    await opts.parentDriver.fanOutDismiss().catch(() => { /* cosmetic */ })
    await new Promise((r) => setTimeout(r, 400))
  }

  const totalMs = Date.now() - startedAt
  const tokensUsed = branches.reduce((s, b) => s + (b.tokensUsed ?? 0), 0)

  return {
    branches,
    feedback: formatFeedback(branches, action.summarize),
    totalMs,
    tokensUsed,
  }
}

type ResolvedSubGoal = NonNullable<FanOutAction['subGoals']>[number]

async function runBranch(
  sg: ResolvedSubGoal,
  index: number,
  opts: FanOutExecutorOptions,
): Promise<FanOutBranchResult> {
  const label = sg.label ?? `branch-${index + 1}`
  const url = sg.url || opts.currentUrl || ''
  const maxTurns = Math.max(1, Math.min(30, sg.maxTurns ?? DEFAULT_SUB_MAX_TURNS))
  const startedAt = Date.now()

  opts.onBranchStart?.(index, label)

  let page: Page | undefined
  // Screenshot streamer: update the branch overlay cell while the branch runs.
  let streamer: ReturnType<typeof setInterval> | undefined
  const startStreamer = (pageRef: Page): void => {
    if (!opts.parentDriver?.fanOutUpdateCell) return
    const tick = async (): Promise<void> => {
      if (!pageRef || pageRef.isClosed()) return
      try {
        const buf = await pageRef.screenshot({
          type: 'jpeg',
          quality: 45,
          timeout: 800,
          // Smaller viewport-style capture keeps the data URL under 40kB
          // so the per-tick page.evaluate round-trip stays fast.
          fullPage: false,
        })
        const dataUrl = `data:image/jpeg;base64,${buf.toString('base64')}`
        await opts.parentDriver!.fanOutUpdateCell!(index, dataUrl).catch(() => { /* cosmetic */ })
      } catch { /* cosmetic — screenshot failures are expected during navigation */ }
    }
    // Kick off immediately so the cell isn't blank for 400ms, then
    // continue at 2.5 FPS. The streamer never blocks the agent loop —
    // failures are swallowed.
    void tick()
    streamer = setInterval(() => void tick(), 400)
  }

  try {
    page = await opts.context.newPage()

    const driver = new PlaywrightDriver(page, {
      ...(opts.driverOptions ?? {}),
      // Sub-tabs render their OWN cursor overlay so the thumbnail
      // streamed to the parent's Hydra cell shows a labeled cursor
      // pointing at what the sub-agent is doing. That cursor never
      // reaches the parent page — it's inside the sub-tab's DOM and
      // only becomes visible via screenshot-streaming.
      showCursor: true,
    })

    // Start streaming AFTER the driver is constructed (cursor install
    // is kicked off in the constructor) so the first thumbnail carries
    // the overlay.
    startStreamer(page)

    const BrowserAgent = await getBrowserAgent()
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

    // Complete the cell with a verdict chip. Kind is derived from the
    // verdict text via the same classifier used by the main overlay's
    // progress-ledger badges.
    if (opts.parentDriver?.fanOutCompleteCell) {
      const kind = classifyVerdict(branchResult.verdict, branchResult.success)
      const chipText = verdictChipText(branchResult.verdict, branchResult.success)
      await opts.parentDriver.fanOutCompleteCell(index, kind, chipText).catch(() => { /* cosmetic */ })
    }

    opts.onBranchComplete?.(index, label, result)
    return branchResult
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const branchResult: FanOutBranchResult = {
      index,
      label,
      url,
      goal: sg.goal,
      success: false,
      verdict: `error: ${msg}`.slice(0, 2000),
      turnsUsed: 0,
      durationMs: Date.now() - startedAt,
    }
    if (opts.parentDriver?.fanOutCompleteCell) {
      await opts.parentDriver.fanOutCompleteCell(index, 'review', 'error').catch(() => { /* cosmetic */ })
    }
    return branchResult
  } finally {
    if (streamer) clearInterval(streamer)
    if (page && !page.isClosed()) {
      await page.close().catch(() => { /* best-effort */ })
    }
  }
}

/**
 * Classify a branch verdict into an overlay kind so the chip color
 * matches the narrative. Mirrors src/runner/overlay-narration.ts.
 */
function classifyVerdict(verdict: string, success: boolean): 'positive' | 'cleared' | 'review' | 'info' {
  if (!success) return 'review'
  if (/POSITIVE\s+MATCH/i.test(verdict)) return 'positive'
  if (/\bCLEARED\b/i.test(verdict)) return 'cleared'
  if (/NEEDS\s+REVIEW/i.test(verdict)) return 'review'
  return 'info'
}

/**
 * Extract a short chip text (≤32 chars) from the verdict. Prefers
 * an explicit status word (POSITIVE / CLEARED / REVIEW) if present;
 * otherwise the first few words.
 */
function verdictChipText(verdict: string, success: boolean): string {
  if (!success) return 'error'
  const m = verdict.match(/(POSITIVE\s+MATCH|CLEARED|NEEDS\s+REVIEW)/i)
  if (m) return m[1].toUpperCase().replace(/\s+/g, ' ')
  const first = verdict.replace(/\s+/g, ' ').trim().slice(0, 32)
  return first || 'done'
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
