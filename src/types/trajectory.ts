import type { Action } from './actions.js';

// ============================================================================
// Trajectory Memory Types
// ============================================================================

export interface TrajectoryStep {
  /** URL at this step */
  url: string;
  /** Action taken */
  action: Action;
  /** Hash of snapshot for similarity comparison */
  snapshotHash: string;
  /** Whether the expected effect was verified */
  verified?: boolean;
  /**
   * The action's expected effect at record time (from `Turn.expectedEffect`).
   * Persisted so ZERO-LLM workflow replay can re-assert a precise post-action
   * effect via the runner's own `verifyExpectedEffect`. Optional: trajectories
   * recorded before this field existed, and turns the brain emitted without an
   * expectedEffect, simply omit it.
   */
  expectedEffect?: string;
}

export interface Trajectory {
  /** Unique ID */
  id: string;
  /** Goal that was achieved */
  goal: string;
  /** Normalized origin for environment scoping (e.g. https://app.example.com) */
  origin?: string;
  /** Steps taken */
  steps: TrajectoryStep[];
  /** Whether this trajectory succeeded */
  success: boolean;
  /** Total duration */
  durationMs: number;
  /** Model used */
  model: string;
  /** When this was recorded */
  timestamp: string;
}
