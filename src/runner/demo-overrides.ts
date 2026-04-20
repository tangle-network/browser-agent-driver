/**
 * Demo-mode decision overrides.
 *
 * Separated from the main runner loop so the production decision path
 * stays free of demo-scaffolding. The runner invokes `applyDemoOverride`
 * once per turn, after the LLM decision is computed; when no environment
 * variables are set the call is a pure no-op and returns the original
 * decision unchanged.
 *
 * Current overrides:
 *   BAD_FORCE_FANOUT_TURN=<N>              — turn to replace the decision
 *   BAD_FORCE_FANOUT_SUBGOALS_JSON=<json>  — subGoals array to inject
 *
 * Use cases:
 *   - Demo recording: deterministically exercise the Hydra View path
 *     even if the current model refuses to emit a fanOut on its own.
 *   - Regression runs: pin a known-good fanOut shape while iterating on
 *     the downstream executor.
 *
 * Extend by adding sibling functions; keep each override cleanly gated
 * on its own env var so activating one doesn't silently activate others.
 */

import type { Action } from '../types.js'

export interface DemoOverrideInput {
  /** The agent's current-turn number (1-indexed). */
  turn: number
  /** The LLM's original decided action. Returned unchanged if no override fires. */
  action: Action
  /** The LLM's original reasoning. Overwritten with a demo-audit trail when we override. */
  reasoning?: string
  /** The LLM's original expectedEffect. Overwritten when we override. */
  expectedEffect?: string
}

export interface DemoOverrideResult {
  action: Action
  reasoning?: string
  expectedEffect?: string
  /** Populated when an override fired — runner emits an override-applied event. */
  override?: {
    tag: string
    feedback: string
  }
}

/**
 * Apply any demo-mode environment overrides to a turn's decision. Returns
 * the decision unchanged when no relevant env vars are set (production
 * runs). Safe to call every turn.
 */
export function applyDemoOverride(input: DemoOverrideInput): DemoOverrideResult {
  const forceTurn = readForceFanOutTurn()
  if (forceTurn !== undefined && forceTurn === input.turn) {
    const injected = buildForceFanOut()
    if (injected) return injected
  }
  return { action: input.action, reasoning: input.reasoning, expectedEffect: input.expectedEffect }
}

function readForceFanOutTurn(): number | undefined {
  const raw = process.env.BAD_FORCE_FANOUT_TURN
  if (!raw) return undefined
  const parsed = parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function buildForceFanOut(): DemoOverrideResult | undefined {
  const raw = process.env.BAD_FORCE_FANOUT_SUBGOALS_JSON
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as Array<{
      url: string
      goal: string
      label?: string
      maxTurns?: number
    }>
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined
    const action: Action = { action: 'fanOut', subGoals: parsed }
    return {
      action,
      reasoning: `Demo override: injecting fanOut with ${parsed.length} sub-goals to exercise the Hydra View path deterministically (set via BAD_FORCE_FANOUT_TURN + BAD_FORCE_FANOUT_SUBGOALS_JSON).`,
      expectedEffect: `${parsed.length} branches return merged verdicts`,
      override: {
        tag: 'demo-force-fanout',
        feedback: `injected ${parsed.length}-branch fanOut`,
      },
    }
  } catch (err) {
    return {
      // Return the action unchanged (no override) but signal the parse
      // error on the override channel so it surfaces in events.jsonl.
      action: { action: 'wait', ms: 0 },
      override: {
        tag: 'demo-force-fanout-parse-error',
        feedback: `BAD_FORCE_FANOUT_SUBGOALS_JSON parse error: ${err instanceof Error ? err.message : 'unknown'}`,
      },
    }
  }
}
