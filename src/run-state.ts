/**
 * RunState — encapsulates loop state variables for the agent run loop.
 *
 * Extracted from runner.ts to reduce scattered mutable state in the main loop.
 */

/**
 * Gen 10 cost cap default. Set high enough that normal cases never hit it
 * but low enough to stop the recovery-loop death-spirals Gen 9 hit.
 *
 * Calibration:
 *   - Gen 8 real-web extraction tasks: ~6k tokens mean (well under cap)
 *   - Tier 1 form-multistep full-evidence: ~60k tokens (within cap + headroom)
 *   - Gen 9 death-spirals: 132k–173k tokens (above cap → caught and aborted)
 *
 * 100k gives normal cases 40k of headroom above the worst-case normal run
 * I've measured (form-multistep), and still catches death spirals in 5–8
 * turns of futility before they burn unbounded cost.
 *
 * Override per-case via Scenario.tokenBudget or globally via the
 * BAD_TOKEN_BUDGET env var.
 */
export const DEFAULT_TOKEN_BUDGET = 100_000;

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

  /** Total LLM tokens (input + output + cache) charged to this case so far. */
  totalTokensUsed = 0;
  /** Token cap for this case. Once exceeded, the runner aborts with cost_cap_exceeded. */
  readonly tokenBudget: number;

  constructor(maxTurns: number, tokenBudget?: number) {
    this.maxTotalErrors = Math.max(3, Math.ceil(maxTurns / 3));
    const envBudget = Number(process.env.BAD_TOKEN_BUDGET);
    this.tokenBudget = tokenBudget
      ?? (Number.isFinite(envBudget) && envBudget > 0 ? envBudget : DEFAULT_TOKEN_BUDGET);
  }

  recordError(): void {
    this.consecutiveErrors++;
    this.totalErrors++;
  }

  clearConsecutiveErrors(): void {
    this.consecutiveErrors = 0;
  }

  recordTokens(tokens: number | undefined): void {
    if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0) {
      this.totalTokensUsed += tokens;
    }
  }

  get isErrorBudgetExhausted(): boolean {
    return this.totalErrors >= this.maxTotalErrors;
  }

  get hasConsecutiveErrorThreshold(): boolean {
    return this.consecutiveErrors >= 3;
  }

  get isTokenBudgetExhausted(): boolean {
    return this.totalTokensUsed >= this.tokenBudget;
  }
}
