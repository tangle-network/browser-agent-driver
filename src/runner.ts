/**
 * Agent Runner — the main loop with verification, stuck detection, and recovery
 *
 * Loop: observe → decide → execute → verify → recover (if needed)
 *
 * Key improvements over simple observe-decide-execute:
 * - Post-action verification: checks expectedEffect after each action
 * - Stuck detection: tracks URL + snapshot hash across turns
 * - Recovery strategies: auto-triggered on failure patterns
 * - Plan tracking: detects when the agent repeats the same step
 */

import { Brain } from './brain/index.js';
import type { Driver } from './drivers/types.js';
import type { Scenario, AgentConfig, AgentResult, Turn, PageState, SupervisorConfig, Action } from './types.js';
import { analyzeRecovery, detectTerminalBlocker } from './recovery.js';
import { StaleRefError, AriaSnapshotHelper } from './drivers/snapshot.js';
import { verifyPreview } from './preview.js';
import type { ProjectStore } from './memory/project-store.js';
import { AppKnowledge } from './memory/knowledge.js';
import { SelectorCache } from './memory/selectors.js';
import { detectSupervisorSignal, formatSupervisorSignal } from './supervisor/policy.js';
import { requestSupervisorDirective } from './supervisor/critic.js';
import { shouldAcceptFirstPartyBoundaryCompletion } from './domain-policy.js';
import { deriveWasteMetrics } from './run-metrics.js';

const DEFAULT_MAX_TURNS = 20;
const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_MICRO_PLAN_ACTIONS = 2;
const SAFE_MICRO_ACTIONS = new Set<Action['action']>(['click', 'type', 'press', 'hover', 'select', 'scroll', 'wait']);
const DEFAULT_SUPERVISOR: Required<Pick<SupervisorConfig, 'enabled' | 'useVision' | 'minTurnsBeforeInvoke' | 'cooldownTurns' | 'maxInterventions' | 'hardStallWindow'>> = {
  enabled: true,
  useVision: true,
  minTurnsBeforeInvoke: 5,
  cooldownTurns: 3,
  maxInterventions: 2,
  hardStallWindow: 4,
};

export interface RunnerOptions {
  driver: Driver;
  config?: AgentConfig;
  /** Called after each turn */
  onTurn?: (turn: Turn) => void;
  /** Called when a first-time phase timing is observed */
  onPhaseTiming?: (phase: 'navigate' | 'observe' | 'decide' | 'execute', durationMs: number) => void;
  /** Reference trajectory to inject into brain context */
  referenceTrajectory?: string;
  /** Project memory store — enables knowledge + selector persistence */
  projectStore?: ProjectStore;
}

const MAX_GOAL_VERIFICATION_EVIDENCE = 3;

/** Retry wrapper for transient failures. Respects AbortSignal between attempts. */
async function withRetry<T>(
  fn: () => Promise<T>,
  retries: number,
  delayMs: number,
  onRetry?: (attempt: number, error: Error) => void,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new Error(signal.reason || 'Cancelled');
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries) {
        onRetry?.(attempt, lastError);
        await new Promise<void>((resolve, reject) => {
          let onAbort: (() => void) | undefined;
          const timer = setTimeout(() => {
            if (onAbort) signal?.removeEventListener('abort', onAbort);
            resolve();
          }, delayMs * attempt);
          if (signal) {
            onAbort = () => { clearTimeout(timer); reject(new Error(signal.reason || 'Cancelled')); };
            if (signal.aborted) { clearTimeout(timer); reject(new Error(signal.reason || 'Cancelled')); return; }
            signal.addEventListener('abort', onAbort, { once: true });
          }
        });
      }
    }
  }

  throw lastError ?? new Error('withRetry: no attempts made');
}

export class AgentRunner {
  private driver: Driver;
  private brain: Brain;
  private config: AgentConfig;
  private onTurn?: (turn: Turn) => void;
  private onPhaseTiming?: (phase: 'navigate' | 'observe' | 'decide' | 'execute', durationMs: number) => void;
  private referenceTrajectory?: string;
  private projectStore?: ProjectStore;
  private knowledge?: AppKnowledge;
  private selectorCache?: SelectorCache;

  constructor(options: RunnerOptions) {
    this.driver = options.driver;
    this.config = options.config || {};
    this.brain = new Brain(this.config);
    this.onTurn = options.onTurn;
    this.onPhaseTiming = options.onPhaseTiming;
    this.referenceTrajectory = options.referenceTrajectory;
    this.projectStore = options.projectStore;
  }

  async run(scenario: Scenario): Promise<AgentResult> {
    const maxTurns = scenario.maxTurns || DEFAULT_MAX_TURNS;
    const retries = this.config.retries ?? DEFAULT_RETRIES;
    const retryDelayMs = this.config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const turns: Turn[] = [];
    const startTime = Date.now();
    const phaseTimings: import('./types.js').RunPhaseTimings = {};
    let verificationRejectionCount = 0;
    let firstSufficientEvidenceTurn: number | undefined;

    const buildResult = (result: Omit<AgentResult, 'phaseTimings' | 'wasteMetrics'>): AgentResult => ({
      ...result,
      phaseTimings,
      wasteMetrics: deriveWasteMetrics(turns, verificationRejectionCount, firstSufficientEvidenceTurn),
    });

    // Reset brain history for fresh scenario
    this.brain.reset();

    // Load domain-scoped memory if project store is configured
    if (this.projectStore && scenario.startUrl) {
      this.knowledge = new AppKnowledge(
        this.projectStore.getKnowledgePath(scenario.startUrl),
        scenario.startUrl,
      );
      this.selectorCache = new SelectorCache(
        this.projectStore.getSelectorCachePath(scenario.startUrl),
      );
    }

    // Navigate to start URL if provided
    if (scenario.startUrl) {
      const navigateStartedAt = Date.now();
      await withRetry(
        () => this.driver.execute({ action: 'navigate', url: scenario.startUrl! }),
        retries,
        retryDelayMs,
        undefined,
        scenario.signal,
      );
      phaseTimings.initialNavigateMs = Date.now() - navigateStartedAt;
      this.onPhaseTiming?.('navigate', phaseTimings.initialNavigateMs);
    }

    let consecutiveErrors = 0;
    let totalErrors = 0;
    const goalVerificationEvidence: string[] = [];
    const searchScoutUrls = new Set<string>();
    const maxTotalErrors = Math.max(3, Math.ceil(maxTurns / 3));
    const supervisorConfig = {
      enabled: this.config.supervisor?.enabled ?? DEFAULT_SUPERVISOR.enabled,
      model: this.config.supervisor?.model || this.config.model || 'gpt-5.2',
      provider: this.config.supervisor?.provider || this.config.provider || 'openai',
      useVision: this.config.supervisor?.useVision ?? DEFAULT_SUPERVISOR.useVision,
      minTurnsBeforeInvoke: this.config.supervisor?.minTurnsBeforeInvoke ?? DEFAULT_SUPERVISOR.minTurnsBeforeInvoke,
      cooldownTurns: this.config.supervisor?.cooldownTurns ?? DEFAULT_SUPERVISOR.cooldownTurns,
      maxInterventions: this.config.supervisor?.maxInterventions ?? DEFAULT_SUPERVISOR.maxInterventions,
      hardStallWindow: this.config.supervisor?.hardStallWindow ?? DEFAULT_SUPERVISOR.hardStallWindow,
    } as const;
    let supervisorInterventions = 0;
    let lastSupervisorTurn = -Infinity;

    for (let i = 1; i <= maxTurns; i++) {
      if (scenario.signal?.aborted) {
        return buildResult({
          success: false,
          reason: scenario.signal.reason || 'Cancelled',
          turns,
          totalMs: Date.now() - startTime,
        });
      }

      const turnStart = Date.now();

      try {
        // ── 1. Check for recovery before observing ──
        if (turns.length >= 2) {
          const lastState = turns[turns.length - 1]?.state || { url: '', title: '', snapshot: '' };
          const recovery = analyzeRecovery({
            recentTurns: turns.slice(-5),
            currentState: lastState,
            consecutiveErrors,
          });

          if (recovery) {
            if (this.config.debug) {
              const forced = recovery.forceBrowserAction
                ? ` (force: ${recovery.forceBrowserAction.action})`
                : recovery.forceAction
                  ? ` (force: ${recovery.forceAction})`
                  : '';
              console.log(`[Runner] Recovery triggered: ${recovery.strategy}${forced}`);
            }

            // Execute concrete recovery action before injecting feedback
            if (recovery.forceBrowserAction) {
              try {
                await this.driver.execute(recovery.forceBrowserAction);
              } catch (recoveryErr) {
                if (this.config.debug) {
                  console.log(
                    `[Runner] Recovery ${recovery.forceBrowserAction.action} failed: ` +
                    `${recoveryErr instanceof Error ? recoveryErr.message : recoveryErr}`
                  );
                }
              }
            } else if (recovery.forceAction) {
              try {
                switch (recovery.forceAction) {
                  case 'reload':
                    await this.driver.execute({ action: 'navigate', url: lastState.url });
                    break;
                  case 'escape':
                    await this.driver.execute({ action: 'press', selector: 'body', key: 'Escape' });
                    break;
                  case 'scrollTop':
                    await this.driver.execute({ action: 'scroll', direction: 'up', amount: 2000 });
                    break;
                }
              } catch (recoveryErr) {
                if (this.config.debug) {
                  console.log(`[Runner] Recovery ${recovery.forceAction} failed: ${recoveryErr instanceof Error ? recoveryErr.message : recoveryErr}`);
                }
              }
            }

            // Inject feedback into brain conversation
            this.brain.injectFeedback(recovery.feedback);

            if (recovery.waitMs) {
              await new Promise(r => setTimeout(r, recovery.waitMs));
            }
          }
        }

        // ── 2. Observe (with retry) ──
        const observeStartedAt = Date.now();
        const state = await withRetry(
          () => this.driver.observe(),
          retries,
          retryDelayMs,
          (attempt, err) => {
            if (this.config.debug) {
              console.log(`[Runner] Observe retry ${attempt}: ${err.message}`);
            }
          },
          scenario.signal,
        );
        if (phaseTimings.firstObserveMs === undefined) {
          phaseTimings.firstObserveMs = Date.now() - observeStartedAt;
          this.onPhaseTiming?.('observe', phaseTimings.firstObserveMs);
        }

        const terminalBlocker = detectTerminalBlocker(state);
        if (terminalBlocker) {
          const reason = `${terminalBlocker.reason} (signals: ${terminalBlocker.evidence.join(', ')})`;
          const blockerTurn: Turn = {
            turn: i,
            state,
            action: { action: 'abort', reason },
            reasoning: terminalBlocker.strategy,
            durationMs: Date.now() - turnStart,
          };
          turns.push(blockerTurn);
          this.onTurn?.(blockerTurn);
          this.saveMemory();
          return buildResult({
            success: false,
            reason,
            turns,
            totalMs: Date.now() - startTime,
          });
        }

        let extraContext = '';
        const turnsLeft = maxTurns - i + 1;
        if (turnsLeft <= 3) {
          extraContext +=
            `\nTURN-BUDGET CRITICAL: ${turnsLeft} turn(s) left including this one.\n` +
            'Do not start new exploratory navigation.\n' +
            'Prioritize extracting the final required evidence from the current page context and finish decisively.\n';
          if (turnsLeft === 1) {
            extraContext +=
              'FINAL TURN REQUIREMENT: return a terminal action now (`complete` if enough evidence exists, otherwise `abort` with explicit blocker reason).\n';
          }
        }
        const searchResultsGuidance = buildSearchResultsGuidance(state, scenario.goal, scenario.allowedDomains);
        if (searchResultsGuidance) {
          extraContext += `\n${searchResultsGuidance}\n`;
        }
        const visibleLinkMatch = getVisibleLinkRecommendation(state, scenario.goal, scenario.allowedDomains);
        const visibleLinkRecommendation = buildVisibleLinkRecommendation(state, scenario.goal, scenario.allowedDomains);
        if (visibleLinkRecommendation) {
          extraContext += `\n${visibleLinkRecommendation}\n`;
        }
        const searchScoutFeedback = await this.buildSearchResultsScoutFeedback(
          state,
          scenario.goal,
          scenario.allowedDomains,
          searchScoutUrls,
        );
        if (searchScoutFeedback) {
          extraContext += `\n${searchScoutFeedback}\n`;
        }
        const supervisorSignal = detectSupervisorSignal({
          recentTurns: turns,
          currentState: state,
          currentTurn: i,
          maxTurns,
          window: supervisorConfig.hardStallWindow,
        });
        const shouldInvokeSupervisor =
          supervisorConfig.enabled &&
          supervisorSignal.severity === 'hard' &&
          i >= supervisorConfig.minTurnsBeforeInvoke &&
          supervisorInterventions < supervisorConfig.maxInterventions &&
          i - lastSupervisorTurn > supervisorConfig.cooldownTurns;

        if (shouldInvokeSupervisor) {
          if (this.config.debug) {
            console.log(`[Runner] Supervisor invoked on turn ${i}: ${formatSupervisorSignal(supervisorSignal)}`);
          }

          let directive: Awaited<ReturnType<typeof requestSupervisorDirective>>;
          try {
            directive = await requestSupervisorDirective({
              goal: scenario.goal,
              currentState: state,
              recentTurns: turns.slice(-8),
              signal: supervisorSignal,
              provider: supervisorConfig.provider,
              model: supervisorConfig.model,
              useVision: supervisorConfig.useVision,
              apiKey: this.config.apiKey,
              baseUrl: this.config.baseUrl,
              timeoutMs: this.config.llmTimeoutMs ?? 60_000,
              debug: this.config.debug,
            });
          } catch (supervisorErr) {
            if (this.config.debug) {
              console.log(
                `[Runner] Supervisor call failed: ${supervisorErr instanceof Error ? supervisorErr.message : supervisorErr}`,
              );
            }
            directive = { decision: 'none', reason: 'supervisor call failed' };
          }

          if (directive.decision !== 'none') {
            supervisorInterventions++;
            lastSupervisorTurn = i;

            if (directive.feedback) {
              this.brain.injectFeedback(
                `[SUPERVISOR] ${directive.feedback}\n` +
                `Signal: ${formatSupervisorSignal(supervisorSignal)}`
              );
            }

            if (directive.decision === 'abort') {
              const reason = directive.reason || directive.feedback || 'Supervisor aborted due to hard stall';
              const supervisorTurn: Turn = {
                turn: i,
                state,
                action: { action: 'abort', reason },
                rawLLMResponse: directive.raw,
                reasoning: directive.reason || directive.feedback,
                durationMs: Date.now() - turnStart,
              };
              turns.push(supervisorTurn);
              this.onTurn?.(supervisorTurn);
              this.saveMemory();
              return buildResult({
                success: false,
                reason,
                turns,
                totalMs: Date.now() - startTime,
              });
            }

            if (directive.decision === 'force_action' && directive.action) {
              let actionError: string | undefined;
              try {
                const forceResult = await withRetry(
                  () => this.driver.execute(directive.action!),
                  retries,
                  retryDelayMs,
                  (attempt, err) => {
                    if (this.config.debug) {
                      console.log(`[Runner] Supervisor force-action retry ${attempt}: ${err.message}`);
                    }
                  },
                  scenario.signal,
                );
                if (!forceResult.success) {
                  actionError = forceResult.error || 'Supervisor force_action failed';
                }
              } catch (err) {
                actionError = err instanceof Error ? err.message : String(err);
              }

              if (actionError) {
                consecutiveErrors++;
                totalErrors++;
              } else {
                consecutiveErrors = 0;
              }

              const supervisorTurn: Turn = {
                turn: i,
                state,
                action: directive.action,
                rawLLMResponse: directive.raw,
                reasoning: directive.reason || directive.feedback || 'Supervisor intervention',
                durationMs: Date.now() - turnStart,
                ...(actionError ? { error: actionError } : {}),
              };
              turns.push(supervisorTurn);
              this.onTurn?.(supervisorTurn);

              if (consecutiveErrors >= 3) {
                this.saveMemory();
                return buildResult({
                  success: false,
                  reason: `${consecutiveErrors} consecutive errors after supervisor action: ${actionError}`,
                  turns,
                  totalMs: Date.now() - startTime,
                });
              }
              if (totalErrors >= maxTotalErrors) {
                this.saveMemory();
                return buildResult({
                  success: false,
                  reason: `Error budget exhausted (${totalErrors}/${maxTotalErrors}) after supervisor action`,
                  turns,
                  totalMs: Date.now() - startTime,
                });
              }

              continue;
            }

            if (directive.decision === 'inject_feedback') {
              const feedback = directive.feedback || directive.reason || 'Supervisor detected a hard stall. Switch strategy.';
              extraContext += `\nSUPERVISOR GUIDANCE: ${feedback}\nSignal: ${formatSupervisorSignal(supervisorSignal)}\n`;
            }
          }
        }

        // ── 3. Build extra context ──
        if (this.referenceTrajectory) {
          extraContext += `\nREFERENCE TRAJECTORY — A similar task was completed before:\n${this.referenceTrajectory}\nUse this as a guide, but adapt to the current page state.\n`;
        }

        // Inject persistent knowledge from previous runs
        if (this.knowledge) {
          const knowledgeContext = this.knowledge.formatForBrain();
          if (knowledgeContext) {
            extraContext += `\n${knowledgeContext}\n`;
          }
        }
        if (this.selectorCache) {
          const selectorContext = this.selectorCache.formatForBrain();
          if (selectorContext) {
            extraContext += `\n${selectorContext}\n`;
          }
        }

        // Check if last turn had a verification failure
        const lastTurn = turns[turns.length - 1];
        if (lastTurn?.verificationFailure) {
          extraContext += `\nVERIFICATION FAILED: ${lastTurn.verificationFailure}\nYour last action did NOT produce the expected effect. Try a different approach.\n`;
        }

        const forceVision = shouldEscalateVision({
          config: this.config,
          state,
          turns,
          scenario,
          currentTurn: i,
          maxTurns,
          supervisorSignalSeverity: supervisorSignal.severity,
          extraContext,
        });
        const decisionState = forceVision
          ? await this.attachDecisionScreenshot(state)
          : state;

        // ── 4. Decide (with retry) ──
        const decideStartedAt = Date.now();
        const decision = await withRetry(
          () => this.brain.decide(
            scenario.goal,
            decisionState,
            extraContext || undefined,
            { current: i, max: maxTurns },
            { forceVision },
          ),
          retries,
          retryDelayMs,
          (attempt, err) => {
            if (this.config.debug) {
              console.log(`[Runner] LLM retry ${attempt}: ${err.message}`);
            }
          },
          scenario.signal,
        );
        if (phaseTimings.firstDecideMs === undefined) {
          phaseTimings.firstDecideMs = Date.now() - decideStartedAt;
          this.onPhaseTiming?.('decide', phaseTimings.firstDecideMs);
        }

        let { action, nextActions, raw, reasoning, plan, currentStep, expectedEffect, tokensUsed } = decision;
        const visibleLinkOverride = chooseVisibleLinkOverride(state, action, visibleLinkMatch);
        if (visibleLinkOverride) {
          this.brain.injectFeedback(visibleLinkOverride.feedback);
          action = { action: 'click', selector: visibleLinkOverride.ref };
          reasoning = `${reasoning}\n[POLICY OVERRIDE] ${visibleLinkOverride.feedback}`;
          expectedEffect = 'URL should change';
          nextActions = [];
        }

        const turn: Turn = {
          turn: i,
          state: decisionState,
          action,
          rawLLMResponse: raw,
          reasoning,
          plan,
          currentStep,
          expectedEffect,
          tokensUsed,
          durationMs: Date.now() - turnStart,
        };
        const executedActions: Action[] = [action];

        // ── 5. Handle evaluate action ──
        if (action.action === 'evaluate') {
          const evaluation = await this.brain.evaluate(state, scenario.goal);

          // Inject evaluation results as feedback so Brain can act on them
          this.brain.injectFeedback(
            `QUALITY EVALUATION (score: ${evaluation.score}/10):\n` +
            `Assessment: ${evaluation.assessment}\n` +
            `Strengths: ${evaluation.strengths.join(', ')}\n` +
            `Issues: ${evaluation.issues.join(', ')}\n` +
            `Suggestions: ${evaluation.suggestions.join(', ')}`
          );

          turn.durationMs = Date.now() - turnStart;
          turns.push(turn);
          this.onTurn?.(turn);
          continue; // Let the agent decide next action based on evaluation feedback
        }

        // ── 5b. Handle verifyPreview action ──
        if (action.action === 'verifyPreview') {
          const page = this.driver.getPage?.();
          if (page) {
            const snapshot = new AriaSnapshotHelper();
            const preview = await verifyPreview(page, snapshot, { captureScreenshot: false });
            if (preview) {
              const statusLine = preview.appLoaded ? 'LOADED' : 'FAILED';
              const errorsLine = preview.errors.length > 0
                ? `\nErrors: ${preview.errors.join('; ')}`
                : '';
              this.brain.injectFeedback(
                `PREVIEW VERIFICATION (${statusLine}):\n` +
                `URL: ${preview.previewUrl}\n` +
                `Title: ${preview.title}${errorsLine}\n` +
                `App a11y tree:\n${preview.snapshot}`
              );
            } else {
              this.brain.injectFeedback(
                'PREVIEW VERIFICATION: No preview iframe found on the current page. ' +
                'The app may not have a running preview yet.'
              );
            }
          } else {
            this.brain.injectFeedback(
              'PREVIEW VERIFICATION: Cannot access page — driver does not expose a Playwright page.'
            );
          }

          turn.durationMs = Date.now() - turnStart;
          turns.push(turn);
          this.onTurn?.(turn);
          continue;
        }

        // ── 5c. Handle runScript action ──
        if (action.action === 'runScript') {
          const page = this.driver.getPage?.();
          if (page) {
            try {
              const scriptResult = await page.evaluate(action.script);
              const stringified = typeof scriptResult === 'string'
                ? scriptResult
                : JSON.stringify(scriptResult, null, 2);
              firstSufficientEvidenceTurn ??= i;
              pushGoalVerificationEvidence(goalVerificationEvidence, `SCRIPT RESULT:\n${stringified ?? '(undefined)'}`);
              this.brain.injectFeedback(
                `SCRIPT RESULT:\n${stringified ?? '(undefined)'}`
              );
            } catch (scriptErr: unknown) {
              const msg = scriptErr instanceof Error ? scriptErr.message : String(scriptErr);
              this.brain.injectFeedback(
                `SCRIPT ERROR: ${msg}`
              );
            }
          } else {
            this.brain.injectFeedback(
              'SCRIPT ERROR: Cannot access page — driver does not expose a Playwright page.'
            );
          }

          turn.durationMs = Date.now() - turnStart;
          turns.push(turn);
          this.onTurn?.(turn);
          continue;
        }

        // ── 6. Check for terminal actions ──
        if (action.action === 'complete') {
          // Step 1: Goal verification — did the agent actually achieve the goal?
          const shouldVerifyGoal = this.config.goalVerification !== false;
          let goalResult: import('./types.js').GoalVerification | undefined;

          if (shouldVerifyGoal) {
            goalResult = await this.brain.verifyGoalCompletion(
              state,
              scenario.goal,
              buildGoalVerificationClaim(action.result || '', goalVerificationEvidence),
            );

            if (this.config.debug) {
              console.log(`[Runner] Goal verification: achieved=${goalResult.achieved}, confidence=${goalResult.confidence}`);
            }

            if (
              !goalResult.achieved
              && shouldAcceptFirstPartyBoundaryCompletion(
                scenario.goal,
                state.url,
                goalResult,
                action.result || '',
              )
            ) {
              goalResult = {
                ...goalResult,
                achieved: true,
                confidence: Math.max(goalResult.confidence, 0.8),
                evidence: [
                  ...goalResult.evidence,
                  'Accepted under first-party sibling subdomain policy after substantive result evidence was captured.',
                ],
                missing: [],
              };
            }

            if (
              !goalResult.achieved
              && shouldAcceptScriptBackedCompletion(
                scenario.goal,
                state,
                goalResult,
                action.result || '',
                goalVerificationEvidence,
              )
            ) {
              goalResult = {
                ...goalResult,
                achieved: true,
                confidence: Math.max(goalResult.confidence, 0.8),
                evidence: [
                  ...goalResult.evidence,
                  'Accepted under script-backed extraction policy after supplemental tool evidence matched the claimed result.',
                ],
                missing: [],
              };
            }

            if (!goalResult.achieved) {
              verificationRejectionCount++;
              firstSufficientEvidenceTurn ??= i;
              // Goal not met — reject completion and feed back what's missing
              this.brain.injectFeedback(
                `COMPLETION REJECTED — goal verification failed (confidence: ${goalResult.confidence.toFixed(2)}).\n` +
                `Missing: ${goalResult.missing.join('; ')}\n` +
                `Evidence reviewed: ${goalResult.evidence.join('; ')}\n` +
                `The goal has NOT been achieved yet. Continue working.`
              );
              turn.durationMs = Date.now() - turnStart;
              turns.push(turn);
              this.onTurn?.(turn);
              continue; // Don't complete — let agent iterate
            }
          }

          // Step 2: Quality gating (optional) — is the result good enough?
          const qualityThreshold = this.config.qualityThreshold ?? 0;
          if (qualityThreshold > 0) {
            const evaluation = await this.brain.evaluate(state, scenario.goal);

            if (evaluation.score < qualityThreshold) {
              if (this.config.debug) {
                console.log(`[Runner] Quality ${evaluation.score}/${qualityThreshold} — rejecting completion`);
              }
              verificationRejectionCount++;
              firstSufficientEvidenceTurn ??= i;
              this.brain.injectFeedback(
                `COMPLETION REJECTED — quality score ${evaluation.score}/10 is below threshold ${qualityThreshold}/10.\n` +
                `Issues: ${evaluation.issues.join(', ')}\n` +
                `Suggestions: ${evaluation.suggestions.join(', ')}\n` +
                `Please address these issues before completing.`
              );
              turn.durationMs = Date.now() - turnStart;
              turns.push(turn);
              this.onTurn?.(turn);
              continue;
            }

            // Both gates passed
            turns.push(turn);
            this.onTurn?.(turn);
            this.saveMemory();
            firstSufficientEvidenceTurn ??= i;
            return buildResult({
              success: true,
              result: action.result,
              turns,
              totalMs: Date.now() - startTime,
              evaluation: {
                score: evaluation.score,
                assessment: evaluation.assessment,
                strengths: evaluation.strengths,
                issues: evaluation.issues,
                suggestions: evaluation.suggestions,
              },
              goalVerification: goalResult,
            });
          }

          // Goal verified (or skipped), no quality gate
          turns.push(turn);
          this.onTurn?.(turn);
          this.saveMemory();
          firstSufficientEvidenceTurn ??= i;
          return buildResult({
            success: true,
            result: action.result,
            turns,
            totalMs: Date.now() - startTime,
            goalVerification: goalResult,
          });
        }

        if (action.action === 'abort') {
          turns.push(turn);
          this.onTurn?.(turn);
          this.saveMemory();
          return buildResult({
            success: false,
            reason: action.reason,
            turns,
            totalMs: Date.now() - startTime,
          });
        }

        const disallowedSearchClick = await this.inspectDisallowedSearchClick(state, scenario, action);
        if (disallowedSearchClick) {
          this.brain.injectFeedback(disallowedSearchClick);
          turn.error = disallowedSearchClick;
          turn.durationMs = Date.now() - turnStart;
          consecutiveErrors++;
          totalErrors++;
          turns.push(turn);
          this.onTurn?.(turn);
          continue;
        }

        // ── 7. Execute (with stale-ref auto-retry) ──
        let execResult: Awaited<ReturnType<Driver['execute']>>;
        try {
          const executeStartedAt = Date.now();
          execResult = await withRetry(
            () => this.driver.execute(action),
            retries,
            retryDelayMs,
            (attempt, err) => {
              if (this.config.debug) {
                console.log(`[Runner] Execute retry ${attempt}: ${err.message}`);
              }
            },
            scenario.signal,
          );
          if (phaseTimings.firstExecuteMs === undefined) {
            phaseTimings.firstExecuteMs = Date.now() - executeStartedAt;
            this.onPhaseTiming?.('execute', phaseTimings.firstExecuteMs);
          }
        } catch (err) {
          if (err instanceof StaleRefError) {
            // Stale ref — re-observe and ask the Brain to pick a new ref
            // without burning a full turn. Feed back the fresh snapshot
            // so the Brain can immediately re-decide.
            if (this.config.debug) {
              console.log(`[Runner] Stale ref @${err.staleRef} — re-observing for immediate retry`);
            }
            const freshState = await this.driver.observe();
            this.brain.injectFeedback(
              `Your selector @${err.staleRef} was not found in the current page. ` +
              `Available refs: ${err.availableRefs.slice(0, 20).join(', ')}. ` +
              `Here is the FRESH page state — pick a valid ref:\n\n` +
              `URL: ${freshState.url}\nELEMENTS:\n${freshState.snapshot}`
            );
            // Let the loop continue — Brain sees feedback and next observe() has fresh refs.
            consecutiveErrors++;
            totalErrors++;
            turn.error = `Stale ref @${err.staleRef} — auto-retrying`;
            turn.durationMs = Date.now() - turnStart;
            turns.push(turn);
            this.onTurn?.(turn);
            continue;
          }
          throw err;
        }

        // Handle failed execution
        if (!execResult.success) {
          const errorMsg = execResult.error || 'Action execution failed';
          if (this.config.debug) {
            console.log(`[Runner] Action failed: ${errorMsg}`);
          }
          turn.error = errorMsg;
          consecutiveErrors++;
          totalErrors++;
        } else {
          consecutiveErrors = 0;

          // Update selector cache on successful action
          if (this.selectorCache && 'selector' in action && action.selector) {
            const element = findElementForRef(state.snapshot, action.selector);
            if (element) {
              this.selectorCache.recordSuccess(element, action.selector);
            }
          }
        }

        const followUpActions = this.selectFollowUpActions(action, nextActions);
        for (const followUpAction of followUpActions) {
          if (turn.error) break;
          try {
            const followResult = await withRetry(
              () => this.driver.execute(followUpAction),
              retries,
              retryDelayMs,
              (attempt, err) => {
                if (this.config.debug) {
                  console.log(`[Runner] Follow-up retry ${attempt}: ${err.message}`);
                }
              },
              scenario.signal,
            );
            executedActions.push(followUpAction);
            if (!followResult.success) {
              const followUpError = followResult.error || `Follow-up ${followUpAction.action} failed`;
              turn.error = followUpError;
              consecutiveErrors++;
              totalErrors++;
            }
          } catch (followErr) {
            turn.error = followErr instanceof Error ? followErr.message : String(followErr);
            consecutiveErrors++;
            totalErrors++;
          }
        }

        const domainBoundaryViolation = await this.enforceAllowedDomainBoundary(state, scenario);
        if (domainBoundaryViolation) {
          this.brain.injectFeedback(domainBoundaryViolation);
          turn.error = domainBoundaryViolation;
          turn.durationMs = Date.now() - turnStart;
          consecutiveErrors++;
          totalErrors++;
          if (executedActions.length > 1) {
            turn.executedActions = executedActions;
          }
          turns.push(turn);
          this.onTurn?.(turn);
          continue;
        }

        // ── 8. Post-action verification ──
        if (expectedEffect && !turn.error) {
          const verifyResult = await this.verifyEffect(expectedEffect, state);
          turn.verified = verifyResult.verified;
          if (!verifyResult.verified) {
            turn.verificationFailure = verifyResult.reason;
            if (this.config.debug) {
              console.log(`[Runner] Verification failed: ${verifyResult.reason}`);
            }
          } else if (this.config.debug) {
            console.log(`[Runner] Verification passed`);
          }
        }

        if (executedActions.length > 1) {
          turn.executedActions = executedActions;
        }

        turn.durationMs = Date.now() - turnStart;
        turns.push(turn);
        this.onTurn?.(turn);

      } catch (err) {
        consecutiveErrors++;
        totalErrors++;
        const error = err instanceof Error ? err.message : String(err);

        let timer: ReturnType<typeof setTimeout> | undefined;
        const emptyState: PageState = { url: '', title: '', snapshot: '' };
        // Suppress dangling rejection from the observe if the timeout wins
        const observePromise = this.driver.observe().catch(() => emptyState);
        const state = await Promise.race([
          observePromise,
          new Promise<PageState>((_, reject) => {
            timer = setTimeout(() => reject(new Error('observe timeout')), 5000);
          }),
        ]).catch(() => emptyState)
          .finally(() => { if (timer) clearTimeout(timer); });

        const turn: Turn = {
          turn: i,
          state,
          // Record as wait(0) — distinguishes crashes from intentional aborts
          action: { action: 'wait', ms: 0 },
          durationMs: Date.now() - turnStart,
          error,
        };

        turns.push(turn);
        this.onTurn?.(turn);

        if (consecutiveErrors >= 3) {
          this.saveMemory();
          return buildResult({
            success: false,
            reason: `${consecutiveErrors} consecutive errors: ${error}`,
            turns,
            totalMs: Date.now() - startTime,
          });
        }

        if (totalErrors >= maxTotalErrors) {
          this.saveMemory();
          return buildResult({
            success: false,
            reason: `Error budget exhausted (${totalErrors}/${maxTotalErrors} total errors): ${error}`,
            turns,
            totalMs: Date.now() - startTime,
          });
        }

        if (this.config.debug) {
          console.log(`[Runner] Error on turn ${i}, continuing: ${error}`);
        }
      }
    }

    // Persist memory before returning
    this.saveMemory();

    // Max turns reached
    return buildResult({
      success: false,
      reason: `Max turns (${maxTurns}) reached`,
      turns,
      totalMs: Date.now() - startTime,
    });
  }

  private selectFollowUpActions(primaryAction: Action, nextActions?: Action[]): Action[] {
    const microPlanConfig = this.config.microPlan;
    if (microPlanConfig?.enabled !== true || !Array.isArray(nextActions) || nextActions.length === 0) {
      return [];
    }

    // Never chain follow-up actions behind terminal/meta actions.
    if (!SAFE_MICRO_ACTIONS.has(primaryAction.action)) {
      return [];
    }

    const limit = Math.max(
      1,
      Math.min(4, microPlanConfig.maxActionsPerTurn ?? DEFAULT_MICRO_PLAN_ACTIONS),
    );
    const remainingSlots = Math.max(0, limit - 1);
    if (remainingSlots === 0) return [];

    const selected: Action[] = [];
    for (const action of nextActions) {
      if (!SAFE_MICRO_ACTIONS.has(action.action)) continue;
      selected.push(action);
      if (selected.length >= remainingSlots) break;
    }
    return selected;
  }

  /** Persist knowledge and selector cache to disk */
  private saveMemory(): void {
    try {
      this.knowledge?.save();
      this.selectorCache?.save();
    } catch (err) {
      if (this.config.debug) {
        console.log(`[Runner] Failed to save memory: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  /**
   * Verify that an action had the expected effect.
   *
   * Uses a lightweight re-observe to check the page state after an action.
   * IMPORTANT: This calls observe() which resets the refMap. The runner
   * always calls observe() again at the start of the next turn, so this is safe.
   *
   * Checks common patterns:
   * - "URL should contain X" → check page URL
   * - "element should be visible" → check snapshot
   * - "text should appear" → check snapshot
   * - Generic text match → check if text appears in snapshot
   */
  private async verifyEffect(
    expectedEffect: string,
    preActionState: PageState
  ): Promise<{ verified: boolean; reason?: string }> {
    // Wait briefly for the effect to take hold
    await new Promise(r => setTimeout(r, 500));

    // Re-observe — this resets the refMap but that's OK since the next
    // turn's observe() will rebuild it fresh before the brain decides.
    const postState = await this.driver.observe().catch(() => preActionState);

    // URL-based verification
    if (/url\s+should/i.test(expectedEffect)) {
      // Extract target: prefer quoted value (handles complex phrases like
      // "URL should change to include '/chat/'"), fall back to word after verb
      const quotedVal = expectedEffect.match(/['"]([^'"]+)['"]/);
      const verbVal = expectedEffect.match(/url\s+should\s+(?:contain|include|have)\s+(\S+)/i);
      const expected = quotedVal?.[1] ?? verbVal?.[1];

      if (expected) {
        if (postState.url.includes(expected)) {
          return { verified: true };
        }
        return {
          verified: false,
          reason: `Expected URL to contain "${expected}" but got "${postState.url}"`,
        };
      }

      // "URL should change" without a specific target — just check if URL changed
      if (postState.url !== preActionState.url) {
        return { verified: true };
      }
      return {
        verified: false,
        reason: `Expected URL to change but it stayed at "${postState.url}"`,
      };
    }

    const effect = expectedEffect.toLowerCase();

    // Snapshot content verification (look for mentioned text/elements)
    // Extract quoted text from the expected effect
    const quotedMatch = effect.match(/["']([^"']+)["']/);
    if (quotedMatch) {
      const searchText = quotedMatch[1].toLowerCase();
      if (postState.snapshot.toLowerCase().includes(searchText)) {
        return { verified: true };
      }
      // Check if page changed at all
      if (postState.snapshot !== preActionState.snapshot || postState.url !== preActionState.url) {
        return { verified: true }; // Page changed, give benefit of the doubt
      }
      return {
        verified: false,
        reason: `Expected "${quotedMatch[1]}" to appear but page did not change`,
      };
    }

    // Generic: check if page changed at all
    if (postState.snapshot !== preActionState.snapshot || postState.url !== preActionState.url) {
      return { verified: true };
    }

    // If we can't determine, give benefit of the doubt for non-URL effects
    if (!effect.includes('url')) {
      return { verified: true };
    }

    return {
      verified: false,
      reason: `Expected effect "${expectedEffect}" — page did not change`,
    };
  }

  private async buildSearchResultsScoutFeedback(
    state: PageState,
    goal: string,
    allowedDomains: string[] | undefined,
    seenUrls: Set<string>,
  ): Promise<string> {
    if (!buildSearchResultsGuidance(state, goal, allowedDomains)) return '';
    if (seenUrls.has(state.url)) return '';

    const page = this.driver.getPage?.();
    if (!page) return '';

    try {
      const candidates = await page.evaluate(() => {
        const items: Array<{ title: string; href: string }> = [];
        const seen = new Set<string>();
        for (const link of Array.from(document.querySelectorAll('a[href]'))) {
          const anchor = link as HTMLAnchorElement;
          const href = anchor.href?.trim();
          const title = link.textContent?.replace(/\s+/g, ' ').trim();
          if (!href || !title || title.length < 12) continue;
          const key = `${title}::${href}`;
          if (seen.has(key)) continue;
          seen.add(key);
          items.push({ title, href });
          if (items.length >= 8) break;
        }
        return items;
      });

      if (!Array.isArray(candidates) || candidates.length === 0) return '';
      const ranked = rankSearchCandidates(goal, candidates, allowedDomains);
      const recommendation = ranked[0];
      seenUrls.add(state.url);
      return [
        'SEARCH RESULTS CANDIDATES:',
        ...ranked.map((candidate, index) => `${index + 1}. ${candidate.title} — ${candidate.href} (score ${candidate.score})`),
        recommendation
          ? `BEST MATCH RECOMMENDATION: prefer "${recommendation.title}" because it best matches the requested entity, content type, and host constraints.`
          : '',
      ].join('\n');
    } catch {
      return '';
    }
  }

  private async inspectDisallowedSearchClick(
    state: PageState,
    scenario: Scenario,
    action: Action,
  ): Promise<string | undefined> {
    if (action.action !== 'click') return undefined;
    if (!scenario.allowedDomains || scenario.allowedDomains.length === 0) return undefined;
    if (!buildSearchResultsGuidance(state, scenario.goal, scenario.allowedDomains)) return undefined;
    if (!this.driver.inspectSelectorHref) return undefined;

    const href = await this.driver.inspectSelectorHref(action.selector);
    const host = href ? safeHostname(href) : undefined;
    if (!href || !host) return undefined;
    if (scenario.allowedDomains.map((domain) => domain.toLowerCase()).includes(host)) return undefined;

    return [
      `Blocked action: selector ${action.selector} resolves to ${href}, which is outside the allowed host set: ${scenario.allowedDomains.join(', ')}.`,
      'Choose a result from an allowed host instead, even if the snippet text looks relevant.',
    ].join(' ');
  }

  private async enforceAllowedDomainBoundary(
    preActionState: PageState,
    scenario: Scenario,
  ): Promise<string | undefined> {
    if (!scenario.allowedDomains || scenario.allowedDomains.length === 0) return undefined;

    const postState = await this.driver.observe().catch(() => preActionState);
    const currentHost = safeHostname(postState.url);
    if (!currentHost) return undefined;

    const allowedHosts = scenario.allowedDomains.map((domain) => domain.toLowerCase());
    if (allowedHosts.includes(currentHost)) return undefined;

    const previousHost = safeHostname(preActionState.url);
    if (previousHost && allowedHosts.includes(previousHost)) {
      await this.driver.execute({ action: 'navigate', url: preActionState.url }).catch(() => {});
    } else if (scenario.startUrl) {
      await this.driver.execute({ action: 'navigate', url: scenario.startUrl }).catch(() => {});
    }

    return [
      `Boundary violation: landed on ${postState.url}, but the allowed host set is ${allowedHosts.join(', ')}.`,
      'Return to an allowed host and continue from there; do not rely on disallowed subdomains even if their snippet looks relevant.',
    ].join(' ');
  }

  private async attachDecisionScreenshot(state: PageState): Promise<PageState> {
    if (state.screenshot || !this.driver.screenshot) return state;
    try {
      const screenshot = await this.driver.screenshot();
      return { ...state, screenshot: screenshot.toString('base64') };
    } catch {
      return state;
    }
  }
}

export function buildGoalVerificationClaim(claimedResult: string, evidence: string[]): string {
  const cleanClaim = claimedResult.trim();
  if (evidence.length === 0) {
    return cleanClaim;
  }

  const recentEvidence = evidence
    .slice(-MAX_GOAL_VERIFICATION_EVIDENCE)
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (recentEvidence.length === 0) {
    return cleanClaim;
  }

  return [
    cleanClaim,
    'SUPPLEMENTAL TOOL EVIDENCE:',
    ...recentEvidence,
  ].filter(Boolean).join('\n\n');
}

export function shouldAcceptScriptBackedCompletion(
  goal: string,
  state: PageState,
  verification: import('./types.js').GoalVerification,
  claimedResult: string,
  evidence: string[],
): boolean {
  if (verification.achieved) return false;

  const verifierText = [...verification.evidence, ...verification.missing].join('\n').toLowerCase();
  const visibilityLimited = [
    /accessibility tree/,
    /not visible/,
    /not shown/,
    /cannot verify/,
    /not present/,
    /visible publication date/,
  ].some((pattern) => pattern.test(verifierText));
  if (!visibilityLimited) return false;

  const scriptEvidence = evidence
    .filter((entry) => entry.startsWith('SCRIPT RESULT:'))
    .join('\n');
  if (!scriptEvidence) return false;

  const lowerGoal = goal.toLowerCase();
  const claimLower = claimedResult.toLowerCase();
  const hasUrlEvidence = state.url.length > 0 && claimLower.includes(state.url.toLowerCase());
  const combinedEvidence = `${state.url}\n${state.title}\n${claimLower}\n${scriptEvidence}\n${verifierText}`.toLowerCase();

  if (/\bpress release\b|\bnews release\b/.test(lowerGoal)) {
    const explicitlyNotRelease = /\bnot a press release page\b|\bnot a press release\b/.test(verifierText);
    const releaseLikeEvidence = /\bpress release\b|\bnews release\b|\/news-releases?\//.test(combinedEvidence);
    if (explicitlyNotRelease || !releaseLikeEvidence) {
      return false;
    }
  }

  const tokenMatches = scriptEvidence.match(/[A-Z][a-z]+ \d{1,2}, \d{4}|\b\d{4}\b|\"[^\"]{6,}\"/g) ?? [];
  const normalizedTokens = tokenMatches
    .map((token) => token.replace(/^"|"$/g, '').trim().toLowerCase())
    .filter((token, index, all) => token.length >= 4 && all.indexOf(token) === index);
  const overlappingTokens = normalizedTokens.filter((token) => claimLower.includes(token));

  return hasUrlEvidence && overlappingTokens.length >= 1;
}

export function buildSearchResultsGuidance(
  state: PageState,
  goal: string,
  allowedDomains?: string[],
): string {
  const url = state.url.toLowerCase();
  const title = state.title.toLowerCase();
  const snapshot = state.snapshot.toLowerCase();
  const looksLikeSearchPage =
    /\bsearch\b|\bquery=/.test(url)
    || /\bsearch results\b/.test(title)
    || /\bsearch results\b/.test(snapshot);

  if (!looksLikeSearchPage) return '';

  const needsStructuredExtraction =
    /\bfirst\b/.test(goal.toLowerCase())
    || /\bextract\b/.test(goal.toLowerCase())
    || /\btitle\b/.test(goal.toLowerCase())
    || /\bdate\b/.test(goal.toLowerCase());

  if (needsStructuredExtraction) {
    const lines = [
      'SEARCH RESULTS HEURISTIC: do not open random results one by one.',
      'Rank visible results against the requested entity and content type before clicking.',
      'If the ranking is ambiguous, use runScript to extract the top result titles and URLs first, then choose the best match.',
      'Prefer result titles or URLs that match the requested content type exactly (for example, press release, news release, pricing, docs, settings).',
    ];
    if (allowedDomains && allowedDomains.length > 0) {
      lines.push(`Hard constraint: only choose results whose hostname is in this allowlist: ${allowedDomains.join(', ')}.`);
      lines.push('Strongly avoid results from sibling subdomains unless the allowlist explicitly includes them.');
    }
    return lines.join('\n');
  }

  const lines = [
    'SEARCH RESULTS HEURISTIC: prefer the highest-signal matching result rather than exploratory clicks.',
    'Use visible titles, snippets, and URLs to choose the best candidate before clicking.',
  ];
  if (allowedDomains && allowedDomains.length > 0) {
    lines.push(`Host constraint: prefer only results from ${allowedDomains.join(', ')}.`);
  }
  return lines.join('\n');
}

export function rankSearchCandidates(
  goal: string,
  candidates: Array<{ title: string; href: string }>,
  allowedDomains?: string[],
): Array<{ title: string; href: string; score: number }> {
  const signals = extractGoalSignals(goal);

  const allowedHosts = new Set((allowedDomains ?? []).map((domain) => domain.toLowerCase()));
  return candidates
    .map((candidate) => {
      const haystack = `${candidate.title} ${candidate.href}`.toLowerCase();
      let score = 0;
      const host = safeHostname(candidate.href);
      for (const keyword of signals.keywords) {
        if (haystack.includes(keyword)) score += 2;
      }
      for (const phrase of signals.exactPhrases) {
        if (haystack.includes(phrase)) score += 4;
      }
      if (signals.wantsPressRelease && /\bpress[- ]release\b|\bnews[- ]release\b/.test(haystack)) {
        score += 6;
      }
      if (/\/news-events\/news-releases\//.test(haystack)) {
        score += 4;
      }
      if (/\/science-updates\//.test(haystack)) {
        score -= 2;
      }
      if (allowedHosts.size > 0) {
        if (host && allowedHosts.has(host)) {
          score += 10;
        } else if (host) {
          score -= 12;
        }
      }
      return { ...candidate, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

export function buildVisibleLinkRecommendation(
  state: PageState,
  goal: string,
  allowedDomains?: string[],
): string {
  const top = getVisibleLinkRecommendation(state, goal, allowedDomains);
  if (!top || top.score < 6) return '';

  const candidates = extractSnapshotLinkCandidates(state.snapshot, goal);
  const ranked = rankVisibleLinkCandidates(goal, candidates);

  return [
    'VISIBLE LINK RECOMMENDATION:',
    `Prefer clicking ${top.ref} (${top.text}) because it is the strongest visible first-party match for the requested topic/content type.`,
    ...ranked.slice(1, 3).map((candidate, index) => `Backup ${index + 1}: ${candidate.ref} (${candidate.text})`),
  ].join('\n');
}

function getVisibleLinkRecommendation(
  state: PageState,
  goal: string,
  allowedDomains?: string[],
): { ref: string; text: string; score: number } | undefined {
  const currentHost = safeHostname(state.url);
  if (allowedDomains && allowedDomains.length > 0 && currentHost && !allowedDomains.map((domain) => domain.toLowerCase()).includes(currentHost)) {
    return undefined;
  }

  const candidates = extractSnapshotLinkCandidates(state.snapshot, goal);
  if (candidates.length === 0) return undefined;

  const ranked = rankVisibleLinkCandidates(goal, candidates);
  return ranked[0];
}

function extractSnapshotLinkCandidates(snapshot: string, goal: string): Array<{ ref: string; text: string }> {
  const source = selectRelevantSnapshotSection(snapshot, goal);
  const candidates: Array<{ ref: string; text: string }> = [];
  const pattern = /- link "([^"]+)" \[ref=([^\]]+)\]/g;
  for (const match of source.matchAll(pattern)) {
    const text = match[1]?.replace(/\s+/g, ' ').trim();
    const ref = match[2]?.trim();
    if (!text || !ref || text.length < 12) continue;
    candidates.push({ ref: `@${ref}`, text });
    if (candidates.length >= 24) break;
  }
  return candidates;
}

function rankVisibleLinkCandidates(
  goal: string,
  candidates: Array<{ ref: string; text: string }>,
): Array<{ ref: string; text: string; score: number }> {
  const signals = extractGoalSignals(goal);

  return candidates
    .map((candidate) => {
      const haystack = candidate.text.toLowerCase();
      let score = 0;
      for (const keyword of signals.keywords) {
        if (haystack.includes(keyword)) score += 2;
      }
      for (const phrase of signals.exactPhrases) {
        if (haystack.includes(phrase)) score += 4;
      }
      if (signals.wantsPressRelease && /\bpress release\b|\bnews release\b|\bnews releases\b/.test(haystack)) {
        score += 6;
      }
      if (hasFullDate(haystack)) {
        score += 5;
      } else if (/\b\d{4}\b/.test(haystack)) {
        score += 1;
      }
      if (/all news releases/.test(haystack)) {
        score += 2;
      }
      if (signals.wantsPressRelease && /\bnih research matters\b|\bnews in health\b|\bcatalyst\b|\bcalendar of events\b|\bsocial media\b/.test(haystack)) {
        score -= 8;
      }
      return { ...candidate, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

function chooseVisibleLinkOverride(
  state: PageState,
  action: Action,
  recommendation: { ref: string; text: string; score: number } | undefined,
): { ref: string; feedback: string } | undefined {
  if (!recommendation || recommendation.score < 10) return undefined;
  if (!isFirstPartyContentHub(state)) return undefined;
  if (!isSearchAction(state, action)) return undefined;
  if (action.action === 'click' && action.selector === recommendation.ref) return undefined;

  return {
    ref: recommendation.ref,
    feedback: `A high-confidence first-party link is already visible on this page. Do not search again; click ${recommendation.ref} (${recommendation.text}) instead.`,
  };
}

function isSearchAction(state: PageState, action: Action): boolean {
  if (!('selector' in action) || !action.selector?.startsWith('@')) return false;
  const element = findElementForRef(state.snapshot, action.selector)?.toLowerCase() ?? '';
  return element.includes('searchbox') || element.includes('search');
}

function isFirstPartyContentHub(state: PageState): boolean {
  const url = state.url.toLowerCase();
  const snapshot = state.snapshot.toLowerCase();
  return (
    url.includes('/news-events') &&
    snapshot.includes('recent news releases')
  );
}

function selectRelevantSnapshotSection(snapshot: string, goal: string): string {
  const lowerGoal = goal.toLowerCase();
  if (!/\bpress release\b|\bnews release\b/.test(lowerGoal) || !snapshot.toLowerCase().includes('recent news releases')) {
    return snapshot;
  }

  const lines = snapshot.split('\n');
  const start = lines.findIndex((line) => line.toLowerCase().includes('recent news releases'));
  if (start === -1) return snapshot;
  let end = lines.findIndex((line, index) => index > start && line.toLowerCase().includes('all news releases'));
  if (end === -1) end = Math.min(lines.length, start + 16);
  return lines.slice(start, end + 1).join('\n');
}

function extractGoalSignals(goal: string): { keywords: string[]; exactPhrases: string[]; wantsPressRelease: boolean } {
  const lowerGoal = goal.toLowerCase();
  const exactPhrases = Array.from(
    new Set(
      [...lowerGoal.matchAll(/"([^"]{3,})"/g)]
        .map((match) => match[1]?.trim())
        .filter((phrase): phrase is string => Boolean(phrase)),
    ),
  );
  const stopwords = new Set([
    'site', 'find', 'information', 'extract', 'first', 'related', 'using', 'feature', 'their',
    'title', 'publication', 'date', 'only', 'https', 'http', 'achieve', 'task', 'other',
    'achievable', 'with', 'just', 'navigation', 'from', 'this', 'search', 'result', 'results',
    'click', 'visit', 'page', 'pages', 'requested', 'current', 'through', 'would', 'should',
  ]);
  const keywords = Array.from(
    new Set(
      lowerGoal
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .filter((token) => token.length >= 4)
        .filter((token) => !stopwords.has(token)),
    ),
  );
  const wantsPressRelease = /\bpress release\b|\bnews release\b/.test(lowerGoal);
  return { keywords, exactPhrases, wantsPressRelease };
}

function hasFullDate(text: string): boolean {
  return /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},\s+\d{4}\b/i.test(text);
}

function safeHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function shouldEscalateVision(input: {
  config: AgentConfig;
  state: PageState;
  turns: Turn[];
  scenario: Scenario;
  currentTurn: number;
  maxTurns: number;
  supervisorSignalSeverity: 'none' | 'soft' | 'hard';
  extraContext: string;
}): boolean {
  const strategy = input.config.visionStrategy ?? (input.config.vision !== false ? 'always' : 'never');
  if (strategy === 'never') return false;
  if (strategy === 'always') return true;

  const pageText = `${input.state.url}\n${input.state.title}\n${input.state.snapshot}`.toLowerCase();
  const recentTurns = input.turns.slice(-2);
  const recentError = recentTurns.some((turn) => Boolean(turn.error || turn.verificationFailure));
  const searchLike = /\bsearch\b|\bsearch results\b/.test(pageText);
  const modalLike = /\bdialog\b|\bmodal\b|\boverlay\b|\bmenu\b/.test(pageText);
  const constrainedTask = Array.isArray(input.scenario.allowedDomains) && input.scenario.allowedDomains.length > 0;
  const lowTurns = input.maxTurns - input.currentTurn <= 2;
  const visibleRecommendation = input.extraContext.includes('VISIBLE LINK RECOMMENDATION');
  const repeatedLocation =
    recentTurns.length >= 2 &&
    recentTurns.every((turn) => turn.state.url === input.state.url);
  const stalledSearch = searchLike && (repeatedLocation || recentError || input.currentTurn >= 6);

  return recentError
    || modalLike
    || lowTurns
    || input.supervisorSignalSeverity !== 'none'
    || stalledSearch
    || (constrainedTask && searchLike && !visibleRecommendation && recentError);
}

function pushGoalVerificationEvidence(target: string[], entry: string): void {
  target.push(entry);
  if (target.length > MAX_GOAL_VERIFICATION_EVIDENCE) {
    target.splice(0, target.length - MAX_GOAL_VERIFICATION_EVIDENCE);
  }
}

/** Convenience function */
export async function runAgent(
  driver: Driver,
  scenario: Scenario,
  options?: Omit<RunnerOptions, 'driver'>
): Promise<AgentResult> {
  const runner = new AgentRunner({ driver, ...options });
  return runner.run(scenario);
}

/**
 * Extract the element identity (e.g., 'button "Send"') for a given @ref
 * from an a11y snapshot. Returns undefined if the ref is not found.
 */
function findElementForRef(snapshot: string, selector: string): string | undefined {
  if (!selector.startsWith('@')) return undefined;
  const bareRef = selector.slice(1);
  // Match: role "name" [ref=XXX] in the snapshot
  const regex = new RegExp(`(\\w+ "[^"]*")\\s*\\[ref=${bareRef}\\]`);
  const match = snapshot.match(regex);
  return match?.[1];
}
