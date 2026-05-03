/**
 * RunState — encapsulates loop state variables for the agent run loop.
 *
 * Extracted from runner.ts to reduce scattered mutable state in the main loop.
 */

/**
 * Default token budget per case. The cap aborts a run with `cost_cap_exceeded`
 * once total LLM tokens (input + output + cache) exceed this number.
 * Override per-case via Scenario.tokenBudget or globally via the
 * BAD_TOKEN_BUDGET env var (env wins — see RunState constructor).
 */
export const DEFAULT_TOKEN_BUDGET = 300_000;

export class RunState {
  consecutiveErrors = 0;
  totalErrors = 0;
  verificationRejectionCount = 0;
  firstSufficientEvidenceTurn: number | undefined;
  supervisorInterventions = 0;
  lastSupervisorTurn = -Infinity;
  goalVerificationEvidence: string[] = [];
  /** Accumulated evidence extracted during the run */
  extractedEvidence: string[] = [];
  searchScoutUrls = new Set<string>();

  // Known-good URLs for rollback on wrong-path recovery.
  checkpoints: Array<{ url: string; turn: number }> = [];

  /**
   * Last turn at which the agent showed verifiable progress: URL changed,
   * snapshot DOM materially changed, or evidence was extracted. Drives the
   * The runner can grant extra turns past configured maxTurns when recent
   * turns show URL, DOM, or evidence progress.
   *
   * Initial value `-Infinity` so a brand-new run with zero observations
   * cannot trigger the extension on its way in.
   *
   * Updated by:
   *   - URL change between consecutive observe-completed events
   *   - Snapshot byte delta > 5% of prior turn (filters noise from
   *     decorative animations / dynamic IDs / timestamps)
   *   - firstSufficientEvidenceTurn being set this turn
   */
  lastProgressTurn = -Infinity;

  readonly maxTotalErrors: number;

  /** Total LLM tokens (input + output + cache) charged to this case so far. */
  totalTokensUsed = 0;
  /** Token cap for this case. Once exceeded, the runner aborts with cost_cap_exceeded. */
  readonly tokenBudget: number;

  constructor(maxTurns: number, tokenBudget?: number) {
    this.maxTotalErrors = Math.max(3, Math.ceil(maxTurns / 3));
    // BAD_TOKEN_BUDGET is an operator override and wins over caller defaults.
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
