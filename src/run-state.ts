/**
 * RunState — encapsulates loop state variables for the agent run loop.
 *
 * Extracted from runner.ts to reduce scattered mutable state in the main loop.
 */

export class RunState {
  consecutiveErrors = 0;
  totalErrors = 0;
  verificationRejectionCount = 0;
  firstSufficientEvidenceTurn: number | undefined;
  supervisorInterventions = 0;
  lastSupervisorTurn = -Infinity;
  goalVerificationEvidence: string[] = [];
  searchScoutUrls = new Set<string>();

  readonly maxTotalErrors: number;

  constructor(maxTurns: number) {
    this.maxTotalErrors = Math.max(3, Math.ceil(maxTurns / 3));
  }

  recordError(): void {
    this.consecutiveErrors++;
    this.totalErrors++;
  }

  clearConsecutiveErrors(): void {
    this.consecutiveErrors = 0;
  }

  get isErrorBudgetExhausted(): boolean {
    return this.totalErrors >= this.maxTotalErrors;
  }

  get hasConsecutiveErrorThreshold(): boolean {
    return this.consecutiveErrors >= 3;
  }
}
