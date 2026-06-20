import type { Action } from './actions.js';

// ============================================================================
// Plan - Structured action sequence
// ============================================================================

/**
 * A single step in a Plan. Wraps an action with a verification checkpoint
 * and optional recovery hint. The runner executes steps deterministically;
 * `expectedEffect` is the post-condition that must hold for the next step
 * to fire.
 */
export interface PlanStep {
  /**
   * The action to execute deterministically. Use batch verbs (`fill`,
   * `clickSequence`) wherever possible to minimize step count.
   */
  action: Action;
  /**
   * Post-condition the runner verifies before advancing. Same shape as
   * the existing `expectedEffect` on Turn — natural-language assertion
   * checked against the post-action snapshot.
   */
  expectedEffect: string;
  /**
   * Optional human-readable description of what this step does. Surfaced
   * in plan-step-executed events for observability and the live viewer.
   */
  rationale?: string;
}

/**
 * A complete plan from `Brain.plan()`. The runner attempts to execute
 * every step deterministically. On the first verification failure or
 * selector miss, the runner falls back to the existing per-action
 * decide loop with a `[REPLAN]` hint in extraContext.
 *
 * Plans are NOT trees — they're flat sequences. Branching is handled
 * by the per-action fallback loop, which decide()'s its way through
 * the unexpected state then potentially re-enters the planner.
 */
export interface Plan {
  /** Steps to execute in order */
  steps: PlanStep[];
  /**
   * Final result text the runner should emit as `complete` if all steps
   * pass verification. If absent, the runner emits a generic completion.
   */
  finalResult?: string;
  /**
   * Plan-level reasoning — what's the strategy, why this sequence?
   * Surfaced in plan-completed events for observability.
   */
  reasoning?: string;
}
