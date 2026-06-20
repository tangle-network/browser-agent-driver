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
