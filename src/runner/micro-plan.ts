/**
 * Micro-plan follow-up selection — given the primary action the LLM chose and
 * the optional `nextActions` it proposed, pick the safe subset to chain in the
 * same turn, bounded by the configured per-turn action cap.
 */

import type { Action } from '../types.js';
import { SAFE_MICRO_ACTIONS, DEFAULT_MICRO_PLAN_ACTIONS } from './constants.js';

export function selectMicroPlanFollowUps(
  primaryAction: Action,
  nextActions: Action[] | undefined,
  microPlanConfig: { enabled?: boolean; maxActionsPerTurn?: number } | undefined,
): Action[] {
  if (microPlanConfig?.enabled !== true || !Array.isArray(nextActions) || nextActions.length === 0) {
    return [];
  }

  // Never chain follow-up actions behind terminal/meta actions.
  if (!SAFE_MICRO_ACTIONS.has(primaryAction.action)) {
    return [];
  }

  const limit = Math.max(
    1,
    Math.min(4, microPlanConfig.maxActionsPerTurn ?? DEFAULT_MICRO_PLAN_ACTIONS),
  );
  const remainingSlots = Math.max(0, limit - 1);
  if (remainingSlots === 0) return [];

  const selected: Action[] = [];
  for (const action of nextActions) {
    if (!SAFE_MICRO_ACTIONS.has(action.action)) continue;
    selected.push(action);
    if (selected.length >= remainingSlots) break;
  }
  return selected;
}
