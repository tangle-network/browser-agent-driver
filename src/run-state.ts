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
  /** Gen 25: accumulated evidence extracted during the run */
  extractedEvidence: string[] = [];
  searchScoutUrls = new Set<string>();

  // Gen 24b: checkpoint replay — save known-good URLs for rollback on wrong-path
  checkpoints: Array<{ url: string; turn: number }> = [];

  readonly maxTotalErrors: number;

  /** Total LLM tokens (input + output + cache) charged to this case so far. */
  totalTokensUsed = 0;
  /** Token cap for this case. Once exceeded, the runner aborts with cost_cap_exceeded. */
  readonly tokenBudget: number;

  constructor(maxTurns: number, tokenBudget?: number) {
    this.maxTotalErrors = Math.max(3, Math.ceil(maxTurns / 3));
    // Gen 30 R3: the env var overrides even when the caller passed an
    // explicit tokenBudget. Reason: BAD_TOKEN_BUDGET is an operator dial
    // (e.g., "bump the cap to 200k for this model") and should beat
    // hard-coded caller defaults like runner.ts's visionBudgetMultiplier.
    // Before this, the env fallback only fired when tokenBudget was
    // undefined, which was never — the runner always passed a number.
    const envBudget = Number(process.env.BAD_TOKEN_BUDGET);
    if (Number.isFinite(envBudget) && envBudget > 0) {
      this.tokenBudget = envBudget;
    } else {
      this.tokenBudget = tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    }
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

  recordEvidence(evidence: string): void {
    if (evidence && evidence.length > 10 && this.extractedEvidence.length < 20) {
      this.extractedEvidence.push(evidence);
    }
  }
}
