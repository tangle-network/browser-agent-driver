import type { Turn } from './turn.js';

// ============================================================================
// Result
// ============================================================================

export interface AgentResult {
  success: boolean;
  result?: string;
  reason?: string;
  turns: Turn[];
  totalMs: number;
  /** Phase timing instrumentation for the run */
  phaseTimings?: RunPhaseTimings;
  /** Startup-path instrumentation for the run */
  startupDiagnostics?: RunStartupDiagnostics;
  /** Wasted-turn instrumentation for the run */
  wasteMetrics?: RunWasteMetrics;
  /** Quality evaluation (if qualityThreshold is set or agent used "evaluate" action) */
  evaluation?: {
    score: number;
    assessment: string;
    strengths: string[];
    issues: string[];
    suggestions: string[];
  };
  /** Goal achievement verification (if goalVerification is enabled) */
  goalVerification?: GoalVerification;
}

export interface GoalVerification {
  /** Did the LLM judge the goal as achieved? */
  achieved: boolean;
  /** Confidence 0-1 */
  confidence: number;
  /** Evidence supporting achievement */
  evidence: string[];
  /** Missing criteria (empty if achieved) */
  missing: string[];
}

export interface RunPhaseTimings {
  initialNavigateMs?: number;
  firstObserveMs?: number;
  firstDecideMs?: number;
  firstExecuteMs?: number;
}

export interface RunStartupDiagnostics {
  firstTurnSeen: boolean;
  timeToFirstTurnMs?: number;
  zeroTurnFailureClass?: 'pre_first_turn_timeout' | 'provider_or_credentials' | 'runner_startup_error' | 'unknown';
  startupReason?: string;
}

export interface RunWasteMetrics {
  repeatedQueryCount: number;
  verificationRejectionCount: number;
  turnsAfterSufficientEvidence: number;
  errorTurns: number;
}
