import type { SnapshotDiff } from '../drivers/snapshot.js';

// ============================================================================
// Page State - What the agent sees
// ============================================================================

export interface PageState {
  /** Current URL */
  url: string;
  /** Page title */
  title: string;
  /** Simplified DOM snapshot (text format) */
  snapshot: string;
  /** Screenshot as base64 JPEG (optional, for debugging) */
  screenshot?: string;
  /** Diff from previous snapshot (undefined on first observe) */
  snapshotDiff?: string;
  /** Structured diff for programmatic use (undefined on first observe) */
  snapshotDiffRaw?: SnapshotDiff;
}
