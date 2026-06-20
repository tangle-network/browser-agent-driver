// ============================================================================
// Scenario - What the agent should accomplish
// ============================================================================

export interface Scenario {
  /** Natural language goal */
  goal: string;
  /** Starting URL (optional - uses current page if not set) */
  startUrl?: string;
  /** Optional task tags, used by adaptive runtime policies */
  tags?: string[];
  /** Explicit host allowlist for navigation/result selection (for benchmark and policy constraints) */
  allowedDomains?: string[];
  /** Max turns before giving up */
  maxTurns?: number;
  /** Abort signal for external cancellation (e.g., story timeout) */
  signal?: AbortSignal;
  /** Session ID for cross-run continuity. Runs with the same ID share session
   *  history regardless of domain. When omitted, sessions are scoped to domain. */
  sessionId?: string;
  /** Parent run ID — set when this run is a resume or fork of a previous run. */
  parentRunId?: string;
}
