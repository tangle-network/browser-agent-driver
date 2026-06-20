/**
 * Runner constants — defaults and thresholds the main loop and its helpers read.
 */

import type { Action, SupervisorConfig } from '../types.js';

export const DEFAULT_MAX_TURNS = 20;
export const DEFAULT_RETRIES = 3;
export const DEFAULT_RETRY_DELAY_MS = 1000;
export const DEFAULT_MICRO_PLAN_ACTIONS = 2;
// Safe action verbs for micro-plans emitted by the model.
export const SAFE_MICRO_ACTIONS = new Set<Action['action']>(['click', 'type', 'press', 'hover', 'select', 'scroll', 'wait', 'clickAt', 'typeAt', 'clickLabel', 'typeLabel']);
export const DEFAULT_SUPERVISOR: Required<Pick<SupervisorConfig, 'enabled' | 'useVision' | 'minTurnsBeforeInvoke' | 'cooldownTurns' | 'maxInterventions' | 'hardStallWindow'>> = {
  enabled: true,
  useVision: true,
  minTurnsBeforeInvoke: 5,
  cooldownTurns: 3,
  maxInterventions: 2,
  hardStallWindow: 4,
};

// One-time max-turns extension thresholds. An active run can receive a single
// extension when it reaches the configured cap while still making page progress.
export const EXTENSION_TURNS_GRANTED = 5;
export const EXTENSION_HARD_CAP = 25;
export const EXTENSION_PROGRESS_LOOKBACK = 3;
