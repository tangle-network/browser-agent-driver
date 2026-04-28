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
/**
 * Default token budget per case. The cap aborts a run with `cost_cap_exceeded`
 * once total LLM tokens (input + output + cache) exceed this number.
 *
 * History:
 *   - Gen 9: 100k cap added to bound runaway recovery loops (after Gen 8.1
 *     burned 130-173k tokens / $0.25-$0.32 per case in death-spiral runs).
 *   - 2026-04-27: bumped 100k → 300k. The Gen 11-era 100k cap was set when
 *     the brain default was a smaller model (gpt-5.2 family). gpt-5.4 is
 *     materially more verbose per turn — the production-shipping cap was
 *     dominating the failure mode (10/12 WebVoyager curated-30 misses were
 *     `cost_cap_exceeded` at the 100k cap). Bumping to 300k took curated-30
 *     pass rate from 60.0% → 86.7% with zero cost_cap aborts.
 *
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
  /** Gen 25: accumulated evidence extracted during the run */
  extractedEvidence: string[] = [];
  searchScoutUrls = new Set<string>();

  // Gen 24b: checkpoint replay — save known-good URLs for rollback on wrong-path
  checkpoints: Array<{ url: string; turn: number }> = [];

  /**
   * Last turn at which the agent showed verifiable progress: URL changed,
   * snapshot DOM materially changed, or evidence was extracted. Drives the
   * 2026-04-28 adaptive-max-turns extension — the runner grants up to 5
   * extra turns past the configured maxTurns IF the last 3 turns showed
   * progress, on the theory that an agent making demonstrable progress
   * 3 turns from the cap should not be cut off arbitrarily.
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
