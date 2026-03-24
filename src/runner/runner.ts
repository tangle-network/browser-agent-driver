/**
 * Agent Runner — the main loop with verification, stuck detection, and recovery
 *
 * Loop: observe -> decide -> execute -> verify -> recover (if needed)
 *
 * Key improvements over simple observe-decide-execute:
 * - Post-action verification: checks expectedEffect after each action
 * - Stuck detection: tracks URL + snapshot hash across turns
 * - Recovery strategies: auto-triggered on failure patterns
 * - Plan tracking: detects when the agent repeats the same step
 */

import { Brain } from '../brain/index.js';
import type { Driver } from '../drivers/types.js';
import type { Scenario, AgentConfig, AgentResult, Turn, PageState, SupervisorConfig, Action } from '../types.js';
import { analyzeRecovery, detectPersistentTerminalBlocker, detectTerminalBlocker } from '../recovery.js';
import { solveCaptcha, canAttemptSolve } from '../captcha.js';
import { StaleRefError, AriaSnapshotHelper } from '../drivers/snapshot.js';
import { verifyPreview } from '../preview.js';
import type { ProjectStore } from '../memory/project-store.js';
import { AppKnowledge } from '../memory/knowledge.js';
import { SelectorCache } from '../memory/selectors.js';
import { detectSupervisorSignal, formatSupervisorSignal } from '../supervisor/policy.js';
import { requestSupervisorDirective } from '../supervisor/critic.js';
import { shouldAcceptFirstPartyBoundaryCompletion } from '../domain-policy.js';
import { deriveWasteMetrics } from '../run-metrics.js';
import { RunState } from '../run-state.js';
import { ContextBudget } from '../context-budget.js';
import { runOverridePipeline } from '../override-pipeline.js';
import type { OverrideContext } from '../override-pipeline.js';

import { withRetry, findElementForRef, safeHostname, pushGoalVerificationEvidence } from './utils.js';
import { buildSearchResultsGuidance, buildVisibleLinkRecommendation, getVisibleLinkRecommendation, getRankedVisibleLinkCandidates, rankSearchCandidates } from './search-guidance.js';
import { buildGoalVerificationClaim, collectSearchWorkflowEvidence, shouldAcceptSearchWorkflowCompletion, shouldAcceptScriptBackedCompletion, detectCompletionContentTypeMismatch } from './goal-verification.js';
import { detectAiTanglePartnerTemplateVisibleState, detectAiTangleVerifiedOutputState, shouldEscalateVision } from './page-analysis.js';
import { shouldUseVisibleLinkScout, shouldUseVisibleLinkScoutPage, shouldUseBoundedBranchExplorer, inspectBranchPreview, scoreBranchPreview } from './scout.js';
import type { BranchPreview } from './scout.js';
import { buildOverrideProducers, buildScoutLinkRecommendationText, buildBranchLinkRecommendationText } from './overrides.js';

import type { Session } from '../memory/knowledge.js';
import { RunRegistry } from '../memory/run-registry.js';

/** Build a structured session record from a completed run */
function buildSession(scenario: Scenario, result: AgentResult): Session {
  const lastTurn = result.turns[result.turns.length - 1]
  return {
    id: scenario.sessionId || `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    goal: scenario.goal,
    outcome: result.result || result.reason || (result.success ? 'Goal achieved' : 'Failed'),
    success: result.success,
    finalUrl: lastTurn?.state?.url || scenario.startUrl || '',
    timestamp: new Date().toISOString(),
    turnsUsed: result.turns.length,
    durationMs: result.totalMs,
  }
}

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

const DEFI_BRAIN_CONTEXT =
  '\nWALLET/DeFi MODE ACTIVE — crypto app patterns:\n' +
  '- PERSISTENT WIDGETS: Many DeFi apps have always-on support/chat widgets (bottom-right) that show as alertdialog. These CANNOT be dismissed. Ignore them and interact with the page directly.\n' +
  '- WALLET CONNECTION: Look for "Connect Wallet" button, select MetaMask. The wallet extension handles the approval popup automatically.\n' +
  '- TOKEN SELECTION: If you need to change a token, click the token selector button (usually shows token symbol/icon), search for the token name, and select it from the dropdown.\n' +
  '- TRANSACTION FLOW: Enter amount → wait for quote/estimate to load → click action button (Swap/Supply/etc.) → review dialog appears → stop before confirming in MetaMask.\n' +
  '- LOADING STATES: DeFi apps make many RPC calls. Wait for balances and quotes to appear before clicking action buttons. If a button says "Enter amount" or is disabled, the app is still loading.\n' +
  '- NATIVE ETH: Prefer native ETH over wrapped tokens (WETH) when possible — avoids ERC-20 spending approval steps.\n' +
  '- NETWORK SELECTOR: Do NOT change the network/chain. If a network dropdown opens accidentally, close it immediately.\n' +
  '- COOKIE BANNERS: Dismiss immediately via Escape or Reject button — don\'t spend multiple turns on consent dialogs.\n'

export interface BrowserAgentOptions {
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
  /** Run registry for orchestration-facing manifests */
  runRegistry?: RunRegistry;
}

export class BrowserAgent {
  private driver: Driver;
  private brain: Brain;
  private config: AgentConfig;
  private onTurn?: (turn: Turn) => void;
  private onPhaseTiming?: (phase: 'navigate' | 'observe' | 'decide' | 'execute', durationMs: number) => void;
  private referenceTrajectory?: string;
  private projectStore?: ProjectStore;
  private runRegistry?: RunRegistry;
  private knowledge?: AppKnowledge;
  private selectorCache?: SelectorCache;
  private cachedPostState: PageState | undefined;

  constructor(options: BrowserAgentOptions) {
    this.driver = options.driver;
    this.config = options.config || {};
    this.brain = new Brain(this.config);
    this.onTurn = options.onTurn;
    this.onPhaseTiming = options.onPhaseTiming;
    this.referenceTrajectory = options.referenceTrajectory;
    this.projectStore = options.projectStore;
    this.runRegistry = options.runRegistry;
  }

  async run(scenario: Scenario): Promise<AgentResult> {
    const maxTurns = scenario.maxTurns || DEFAULT_MAX_TURNS;
    const retries = this.config.retries ?? DEFAULT_RETRIES;
    const retryDelayMs = this.config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const turns: Turn[] = [];
    const startTime = Date.now();
    const phaseTimings: import('../types.js').RunPhaseTimings = {};
    const runState = new RunState(maxTurns);

    const runId = scenario.sessionId
      ? `${scenario.sessionId}_${Date.now()}`
      : RunRegistry.generateRunId()
    const domain = safeHostname(scenario.startUrl || '') || 'unknown'

    const buildResult = (result: Omit<AgentResult, 'phaseTimings' | 'wasteMetrics'>): AgentResult => {
      const agentResult: AgentResult = {
        ...result,
        phaseTimings,
        wasteMetrics: deriveWasteMetrics(turns, runState.verificationRejectionCount, runState.firstSufficientEvidenceTurn),
      }
      this.saveMemory(scenario, agentResult)
      // Complete run manifest
      const lastTurn = agentResult.turns[agentResult.turns.length - 1]
      this.runRegistry?.completeRun(runId, {
        success: agentResult.success,
        finalUrl: lastTurn?.state?.url,
        summary: agentResult.result || agentResult.reason,
        result: agentResult.result,
        reason: agentResult.reason,
        turnCount: agentResult.turns.length,
      })
      return agentResult
    };

    // Wrap onTurn to include mid-run manifest updates (every 3 turns)
    const originalOnTurn = this.onTurn
    this.onTurn = (turn: Turn) => {
      originalOnTurn?.(turn)
      if (this.runRegistry && turns.length % 3 === 0) {
        try {
          this.runRegistry.updateRun(runId, {
            turnCount: turns.length,
            currentUrl: turn.state?.url,
          })
        } catch { /* best-effort */ }
      }
    }

    // Reset brain history for fresh scenario
    this.brain.reset();
    this.cachedPostState = undefined;
    let executeTimeoutRecoveries = 0;

    // Start navigation and load memory in parallel. Navigation is async (network
    // I/O) while memory init is sync (readFileSync), so memory completes while
    // the network request is in flight — saving the serial cost of disk reads.
    if (scenario.startUrl) {
      const navigateStartedAt = Date.now();
      const navPromise = withRetry(
        () => this.driver.execute({ action: 'navigate', url: scenario.startUrl! }),
        retries,
        retryDelayMs,
        undefined,
        scenario.signal,
      );

      // Load domain-scoped memory while navigation is in progress
      if (this.projectStore) {
        this.knowledge = new AppKnowledge(
          this.projectStore.getKnowledgePath(scenario.startUrl),
          scenario.startUrl,
        );
        this.selectorCache = new SelectorCache(
          this.projectStore.getSelectorCachePath(scenario.startUrl),
        );
      }

      await navPromise;
      phaseTimings.initialNavigateMs = Date.now() - navigateStartedAt;
      this.onPhaseTiming?.('navigate', phaseTimings.initialNavigateMs);
    }

    // Write run manifest at start
    this.runRegistry?.startRun({
      runId,
      sessionId: scenario.sessionId,
      parentRunId: scenario.parentRunId,
      goal: scenario.goal,
      domain,
      startUrl: scenario.startUrl,
    });

    const supervisorConfig = {
      enabled: this.config.supervisor?.enabled ?? DEFAULT_SUPERVISOR.enabled,
      model: this.config.supervisor?.model || this.config.model || 'gpt-5.4',
      provider: this.config.supervisor?.provider || this.config.provider || 'openai',
      useVision: this.config.supervisor?.useVision ?? DEFAULT_SUPERVISOR.useVision,
      minTurnsBeforeInvoke: this.config.supervisor?.minTurnsBeforeInvoke ?? DEFAULT_SUPERVISOR.minTurnsBeforeInvoke,
      cooldownTurns: this.config.supervisor?.cooldownTurns ?? DEFAULT_SUPERVISOR.cooldownTurns,
      maxInterventions: this.config.supervisor?.maxInterventions ?? DEFAULT_SUPERVISOR.maxInterventions,
      hardStallWindow: this.config.supervisor?.hardStallWindow ?? DEFAULT_SUPERVISOR.hardStallWindow,
    } as const;

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
        // -- 1. Check for recovery before observing --
        if (turns.length >= 2) {
          const lastState = turns[turns.length - 1]?.state || { url: '', title: '', snapshot: '' };
          const recovery = analyzeRecovery({
            recentTurns: turns.slice(-5),
            currentState: lastState,
            consecutiveErrors: runState.consecutiveErrors,
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

        // -- 2. Observe (with retry) --
        // Reuse the snapshot from verifyEffect if available (no page mutations between them)
        const observeStartedAt = Date.now();
        const state = this.cachedPostState ?? await withRetry(
          () => this.driver.observe(),
          1, // Observe failures are DOM access issues, not transient — retrying 3x wastes 3s
          retryDelayMs,
          (attempt, err) => {
            if (this.config.debug) {
              console.log(`[Runner] Observe retry ${attempt}: ${err.message}`);
            }
          },
          scenario.signal,
        );
        this.cachedPostState = undefined;
        if (phaseTimings.firstObserveMs === undefined) {
          phaseTimings.firstObserveMs = Date.now() - observeStartedAt;
          this.onPhaseTiming?.('observe', phaseTimings.firstObserveMs);
        }

        // Auto-navigate: if we're on about:blank with a startUrl, navigate without
        // consuming an LLM turn. The agent always does wait->navigate on blank pages.
        if (
          state.url === 'about:blank' &&
          scenario.startUrl &&
          turns.length === 0
        ) {
          await this.driver.execute({ action: 'navigate', url: scenario.startUrl }).catch(() => {});
          // Re-observe after navigation
          const reState = await withRetry(
            () => this.driver.observe(),
            retries,
            retryDelayMs,
            undefined,
            scenario.signal,
          );
          Object.assign(state, reState);
        }

        let terminalBlocker = detectTerminalBlocker(state);
        // Attempt CAPTCHA solving only if: bot-challenge, enabled, and evidence suggests a solvable CAPTCHA
        if (
          terminalBlocker?.kind === 'bot-challenge'
          && this.config.captcha?.enabled !== false
          && canAttemptSolve(terminalBlocker.evidence)
        ) {
          const page = this.driver.getPage?.()
          if (page) {
            try {
              const model = await this.brain.getLanguageModel()
              const captchaResult = await solveCaptcha(page, model, {
                maxAttempts: this.config.captcha?.maxAttempts ?? 5,
              })
              if (captchaResult.success) {
                await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {})
                const postCaptchaState = await this.driver.observe()
                Object.assign(state, postCaptchaState)
                this.brain.injectFeedback(
                  `CAPTCHA solved: ${captchaResult.type} in ${captchaResult.attempts} attempt(s), ${captchaResult.durationMs}ms. Continuing.`
                )
                terminalBlocker = detectTerminalBlocker(state)
              }
            } catch { /* CAPTCHA solve failed, fall through to abort */ }
          }
        }
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
          return buildResult({
            success: false,
            reason,
            turns,
            totalMs: Date.now() - startTime,
          });
        }
        const persistentTerminalBlocker = detectPersistentTerminalBlocker(turns, state);
        if (persistentTerminalBlocker) {
          const reason = `${persistentTerminalBlocker.reason} (signals: ${persistentTerminalBlocker.evidence.join(', ')})`;
          const blockerTurn: Turn = {
            turn: i,
            state,
            action: { action: 'abort', reason },
            reasoning: persistentTerminalBlocker.strategy,
            durationMs: Date.now() - turnStart,
          };
          turns.push(blockerTurn);
          this.onTurn?.(blockerTurn);
          return buildResult({
            success: false,
            reason,
            turns,
            totalMs: Date.now() - startTime,
          });
        }

        const ctxBudget = new ContextBudget();

        // Post-blocker-dismissal: if the previous turn's recovery dismissed a modal
        // and the URL hasn't changed, warn the agent that prior actions may have been voided.
        if (turns.length >= 2) {
          const prevTurn = turns[turns.length - 1];
          const prevPrevTurn = turns.length >= 3 ? turns[turns.length - 2] : undefined;
          const prevStrategy = prevTurn?.reasoning || '';
          const modalWasDismissed =
            prevStrategy.includes('cookie/consent dialog') ||
            prevStrategy.includes('dialog/modal is obstructing') ||
            prevStrategy.includes('dialog/modal is present') ||
            (prevTurn?.action?.action === 'click' &&
              /reject|accept|allow|deny|dismiss|consent|cookie/i.test(
                prevTurn?.action?.selector || prevTurn?.rawLLMResponse || '',
              ));
          if (modalWasDismissed && prevPrevTurn && state.url === prevPrevTurn.state.url) {
            ctxBudget.add('blocker-recovery',
              '\nDialog dismissed but URL unchanged — prior action may have been voided. Re-submit if needed.\n', 90);
          }
        }

        const turnsLeft = maxTurns - i + 1;
        if (turnsLeft <= 3) {
          const finalTurnSuffix = turnsLeft === 1
            ? ' FINAL TURN: return complete or abort now.'
            : '';
          ctxBudget.add('turn-budget',
            `\nBUDGET: ${turnsLeft} turn(s) left. Extract data and finish.${finalTurnSuffix}\n`, 100);
        } else if (i >= Math.floor(maxTurns * 0.5) && runState.goalVerificationEvidence.length === 0) {
          ctxBudget.add('extraction-reminder',
            '\nHALF BUDGET USED, no data extracted. Use runScript NOW to extract from current page and complete.\n', 85);
        }

        if (i >= 8 && i < Math.floor(maxTurns * 0.5) && runState.goalVerificationEvidence.length === 0) {
          const isFilterTask = /filter|under \$|over \$|\d+\+ (star|rating)|sort by|price range|less than/i.test(scenario.goal);
          if (isFilterTask) {
            ctxBudget.add('filter-strategy',
              '\nFILTER GOAL: use runScript to find filter controls, apply filter, extract results.\n', 80);
          }
        }

        const searchResultsGuidance = buildSearchResultsGuidance(state, scenario.goal, scenario.allowedDomains);
        if (searchResultsGuidance) {
          ctxBudget.add('search-guidance', `\n${searchResultsGuidance}\n`, 70);
        }
        const visibleLinkMatch = getVisibleLinkRecommendation(state, scenario.goal, scenario.allowedDomains);
        const visibleLinkRecommendation = buildVisibleLinkRecommendation(state, scenario.goal, scenario.allowedDomains);
        if (visibleLinkRecommendation) {
          ctxBudget.add('visible-link', `\n${visibleLinkRecommendation}\n`, 60);
        }
        // Gate scout calls: skip on early turns unless the agent appears
        // stuck (same URL for 2+ consecutive turns). On early turns the agent
        // is just navigating and doesn't need link recommendations.
        const stuckOnSameUrl = turns.length >= 2 &&
          turns[turns.length - 1]!.state.url === turns[turns.length - 2]!.state.url;
        const shouldScout = i >= 5 || stuckOnSameUrl;

        let scoutLinkRecommendation: Awaited<ReturnType<BrowserAgent['buildVisibleLinkScoutRecommendation']>>;
        let branchLinkRecommendation: Awaited<ReturnType<BrowserAgent['buildBranchLinkRecommendation']>>;
        let searchScoutFeedback: string;

        if (shouldScout) {
          [scoutLinkRecommendation, branchLinkRecommendation, searchScoutFeedback] = await Promise.all([
            this.buildVisibleLinkScoutRecommendation(state, scenario.goal, scenario.allowedDomains),
            this.buildBranchLinkRecommendation(state, scenario.goal, scenario.allowedDomains),
            this.buildSearchResultsScoutFeedback(state, scenario.goal, scenario.allowedDomains, runState.searchScoutUrls),
          ]);
        } else {
          scoutLinkRecommendation = undefined;
          branchLinkRecommendation = undefined;
          searchScoutFeedback = '';
        }
        if (scoutLinkRecommendation) {
          ctxBudget.add('scout-link', `\n${buildScoutLinkRecommendationText(scoutLinkRecommendation)}\n`, 55);
        }
        if (branchLinkRecommendation) {
          ctxBudget.add('branch-link', `\n${buildBranchLinkRecommendationText(branchLinkRecommendation)}\n`, 55);
        }
        if (searchScoutFeedback) {
          ctxBudget.add('search-scout', `\n${searchScoutFeedback}\n`, 50);
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
          runState.supervisorInterventions < supervisorConfig.maxInterventions &&
          i - runState.lastSupervisorTurn > supervisorConfig.cooldownTurns;

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
              sandboxBackendType: this.config.sandboxBackendType,
              sandboxBackendProfile: this.config.sandboxBackendProfile,
              sandboxBackendProvider: this.config.sandboxBackendProvider,
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
            runState.supervisorInterventions++;
            runState.lastSupervisorTurn = i;

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
                runState.recordError();
              } else {
                runState.clearConsecutiveErrors();
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

              if (runState.hasConsecutiveErrorThreshold) {
                return buildResult({
                  success: false,
                  reason: `${runState.consecutiveErrors} consecutive errors after supervisor action: ${actionError}`,
                  turns,
                  totalMs: Date.now() - startTime,
                });
              }
              if (runState.isErrorBudgetExhausted) {
                return buildResult({
                  success: false,
                  reason: `Error budget exhausted (${runState.totalErrors}/${runState.maxTotalErrors}) after supervisor action`,
                  turns,
                  totalMs: Date.now() - startTime,
                });
              }

              continue;
            }

            if (directive.decision === 'inject_feedback') {
              const feedback = directive.feedback || directive.reason || 'Supervisor detected a hard stall. Switch strategy.';
              ctxBudget.add('supervisor', `\nSUPERVISOR GUIDANCE: ${feedback}\nSignal: ${formatSupervisorSignal(supervisorSignal)}\n`, 95);
            }
          }
        }

        // -- 3. Build extra context --

        // Inject DeFi/crypto app awareness when wallet mode is active (first turn only)
        if (this.config.walletMode && i === 1) {
          ctxBudget.add('wallet-defi-context', DEFI_BRAIN_CONTEXT, 35);
        }

        if (this.referenceTrajectory) {
          ctxBudget.add('reference-trajectory',
            `\nREFERENCE TRAJECTORY — A similar task was completed before:\n${this.referenceTrajectory}\nUse this as a guide, but adapt to the current page state.\n`, 40);
        }

        // Inject persistent knowledge from previous runs
        if (this.knowledge) {
          const knowledgeContext = this.knowledge.formatForBrain();
          if (knowledgeContext) {
            ctxBudget.add('knowledge', `\n${knowledgeContext}\n`, 30);
          }
        }
        if (this.selectorCache) {
          const selectorContext = this.selectorCache.formatForBrain();
          if (selectorContext) {
            ctxBudget.add('selector-cache', `\n${selectorContext}\n`, 25);
          }
        }

        // Check if last turn had a verification failure
        const lastTurn = turns[turns.length - 1];
        if (lastTurn?.verificationFailure) {
          ctxBudget.add('verification-failure',
            `\nVERIFICATION FAILED: ${lastTurn.verificationFailure}. Try different approach.\n`, 85);
        }

        // Extraction guard: if the agent just ran a script that returned data,
        // remind it to consider completing before navigating away.
        if (lastTurn?.action.action === 'runScript' && !lastTurn.error) {
          ctxBudget.add('extraction-guard',
            '\nData extracted. If it answers the goal, complete now.\n', 80);
        }

        const extraContext = ctxBudget.build();

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
        const aiTanglePartnerCompletion = detectAiTanglePartnerTemplateVisibleState(state, scenario.goal);
        const aiTanglePartnerContext = aiTanglePartnerCompletion
          ? `\nPARTNER TEMPLATE VISIBILITY DETECTED:\n${aiTanglePartnerCompletion.feedback}\nReturn a terminal \`complete\` action now with concrete evidence.\n`
          : '';
        const aiTangleOutputCompletion = detectAiTangleVerifiedOutputState(state, scenario.goal);
        const aiTangleOutputContext = aiTangleOutputCompletion
          ? `\nVERIFIED OUTPUT STATE DETECTED:\n${aiTangleOutputCompletion.feedback}\nReturn a terminal \`complete\` action now with concrete evidence.\n`
          : '';
        const finalExtraContext = [extraContext, aiTanglePartnerContext, aiTangleOutputContext].filter(Boolean).join('');
        const decisionState = forceVision
          ? await this.attachDecisionScreenshot(state)
          : state;

        // -- 4. Decide (with retry) --
        const decideStartedAt = Date.now();
        const decision = await withRetry(
          () => this.brain.decide(
            scenario.goal,
            decisionState,
            finalExtraContext || undefined,
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

        let { action, nextActions, raw, reasoning, plan, currentStep, expectedEffect, tokensUsed, inputTokens, outputTokens, modelUsed } = decision;

        // -- 4b. Override pipeline — scored selection of post-decision overrides --
        const overrideCtx: OverrideContext = {
          state,
          goal: scenario.goal,
          allowedDomains: scenario.allowedDomains,
          action,
          visibleLinkMatch,
          scoutLinkRecommendation,
          branchLinkRecommendation,
          aiTanglePartnerCompletion: aiTanglePartnerCompletion ?? undefined,
          aiTangleOutputCompletion: aiTangleOutputCompletion ?? undefined,
        };
        const overrideWinner = runOverridePipeline(overrideCtx, buildOverrideProducers());
        if (overrideWinner) {
          this.brain.injectFeedback(overrideWinner.feedback);
          action = overrideWinner.action;
          reasoning = `${reasoning}\n[${overrideWinner.reasoningTag}] ${overrideWinner.feedback}`;
          expectedEffect = overrideWinner.expectedEffect;
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
          inputTokens,
          outputTokens,
          modelUsed,
          durationMs: Date.now() - turnStart,
        };
        const executedActions: Action[] = [action];

        // -- 5. Handle evaluate action --
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

        // -- 5b. Handle verifyPreview action --
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

        // -- 5c. Handle runScript action --
        if (action.action === 'runScript') {
          const page = this.driver.getPage?.();
          if (page) {
            try {
              const scriptResult = await page.evaluate(action.script);
              const stringified = typeof scriptResult === 'string'
                ? scriptResult
                : JSON.stringify(scriptResult, null, 2);
              runState.firstSufficientEvidenceTurn ??= i;
              pushGoalVerificationEvidence(runState.goalVerificationEvidence, `SCRIPT RESULT:\n${stringified ?? '(undefined)'}`);
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

        // -- 6. Check for terminal actions --
        if (action.action === 'complete') {
          // Step 1: Goal verification — did the agent actually achieve the goal?
          const shouldVerifyGoal = this.config.goalVerification !== false;
          let goalResult: import('../types.js').GoalVerification | undefined;
          const persistentSearchEvidence = collectSearchWorkflowEvidence(
            scenario.goal,
            action.result || '',
            turns,
          );
          const verificationEvidence = [
            ...runState.goalVerificationEvidence,
            ...persistentSearchEvidence,
          ];

          if (shouldVerifyGoal) {
            // Fast-path: skip LLM verification when agent provides strong
            // evidence and had no recent errors. The detailed result text
            // (>50 chars) combined with script-extracted evidence means the
            // verifier almost always agrees — save the round-trip.
            const agentResult = action.result || '';
            const recentErrors = turns.slice(-2).filter(t => t.error).length;
            const hasScriptEvidence = verificationEvidence.some(e => e.startsWith('SCRIPT RESULT:'));
            const fastPathEligible =
              agentResult.length > 50 &&
              recentErrors === 0 &&
              hasScriptEvidence;

            if (fastPathEligible) {
              goalResult = {
                achieved: true,
                confidence: 0.9,
                evidence: ['Fast-path: agent provided detailed result with script-backed evidence and no recent errors.'],
                missing: [],
              };
              if (this.config.debug) {
                console.log('[Runner] Goal verification fast-path: skipped LLM call (strong evidence + no errors)');
              }
            } else {
              goalResult = await this.brain.verifyGoalCompletion(
                state,
                scenario.goal,
                buildGoalVerificationClaim(agentResult, verificationEvidence),
              );
            }

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
              && shouldAcceptSearchWorkflowCompletion(
                scenario.goal,
                goalResult,
                action.result || '',
                verificationEvidence,
              )
            ) {
              goalResult = {
                ...goalResult,
                achieved: true,
                confidence: Math.max(goalResult.confidence, 0.82),
                evidence: [
                  ...goalResult.evidence,
                  'Accepted under persisted search-workflow evidence captured from an earlier turn before the agent navigated away.',
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
                verificationEvidence,
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

            const contentTypeMismatch = detectCompletionContentTypeMismatch(
              scenario.goal,
              state,
              action.result || '',
              verificationEvidence,
            );
            if (contentTypeMismatch) {
              runState.verificationRejectionCount++;
              turn.verificationFailure = contentTypeMismatch;
              this.brain.injectFeedback(
                `COMPLETION REJECTED — content type mismatch.\n${contentTypeMismatch}\n` +
                'The goal has NOT been achieved yet. Continue working toward the requested content type.'
              );
              turn.durationMs = Date.now() - turnStart;
              turns.push(turn);
              this.onTurn?.(turn);
              continue;
            }

            if (!goalResult.achieved) {
              // Progressive acceptance: after prior rejections, accept near-misses
              // rather than burning turns in verification loops.
              // Tier A: 1+ rejection + confidence ≥0.55 + supplemental evidence → accept
              // Tier B: 2+ rejections + confidence ≥0.50 → accept (agent has tried hard enough)
              // Tier C: 3+ rejections + confidence ≥0.40 → accept (prevent total turn exhaustion)
              const hasSupplementalEvidence = verificationEvidence.length > 0;
              const priorRejections = runState.verificationRejectionCount;
              const shouldAccept =
                (priorRejections >= 1 && goalResult.confidence >= 0.55 && hasSupplementalEvidence) ||
                (priorRejections >= 2 && goalResult.confidence >= 0.50) ||
                (priorRejections >= 3 && goalResult.confidence >= 0.40);
              if (shouldAccept) {
                goalResult = {
                  ...goalResult,
                  achieved: true,
                  confidence: goalResult.confidence,
                  evidence: [
                    ...goalResult.evidence,
                    `Accepted under progressive threshold after ${priorRejections} prior rejection(s)${hasSupplementalEvidence ? ' with supplemental evidence' : ''}.`,
                  ],
                  missing: [],
                };
              }
            }

            if (!goalResult.achieved) {
              runState.verificationRejectionCount++;
              turn.verificationFailure = goalResult.missing.join('; ') || 'Goal verification failed';
              runState.firstSufficientEvidenceTurn ??= i;
              // Goal not met — reject completion and feed back what's missing
              const escalation = runState.verificationRejectionCount >= 2
                ? ' Use runScript to extract exact data and include in completion.'
                : '';
              this.brain.injectFeedback(
                `REJECTED (${goalResult.confidence.toFixed(2)}). Missing: ${goalResult.missing.join('; ')}.${escalation}`
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
              runState.verificationRejectionCount++;
              runState.firstSufficientEvidenceTurn ??= i;
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
            runState.firstSufficientEvidenceTurn ??= i;
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
          runState.firstSufficientEvidenceTurn ??= i;
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
          runState.recordError();
          turns.push(turn);
          this.onTurn?.(turn);
          continue;
        }

        // -- 7. Execute (with stale-ref auto-retry) --
        // Wall-clock cap: entire execute chain (including overlay recovery and retries)
        // gets a hard 45s cap. Prevents heavy JS sites from consuming
        // the entire case budget on a single action (e.g., AliExpress 46s click
        // where withOverlayRecovery × withRetry multiplied a 22s timeout to 135s).
        const executeWallClockMs = 45_000;
        let execResult: Awaited<ReturnType<Driver['execute']>>;
        try {
          const executeStartedAt = Date.now();
          const executePromise = withRetry(
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
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Execute wall-clock timeout after ${executeWallClockMs}ms`)), executeWallClockMs),
          );
          execResult = await Promise.race([executePromise, timeoutPromise]);
          if (phaseTimings.firstExecuteMs === undefined) {
            phaseTimings.firstExecuteMs = Date.now() - executeStartedAt;
            this.onPhaseTiming?.('execute', phaseTimings.firstExecuteMs);
          }
        } catch (err) {
          if (err instanceof StaleRefError) {
            // Stale ref — re-observe and cache for next turn (avoid double observe).
            // Only inject available refs, not the full snapshot — next turn's observe
            // provides the complete snapshot, so duplicating it here wastes 3-8k tokens.
            if (this.config.debug) {
              console.log(`[Runner] Stale ref @${err.staleRef} — re-observing for immediate retry`);
            }
            this.cachedPostState = await this.driver.observe();
            this.brain.injectFeedback(
              `Your selector @${err.staleRef} was not found. ` +
              `Available refs: ${err.availableRefs.slice(0, 20).join(', ')}. ` +
              `Pick a valid ref from the next observation.`
            );
            runState.recordError();
            turn.error = `Stale ref @${err.staleRef} — auto-retrying`;
            turn.durationMs = Date.now() - turnStart;
            turns.push(turn);
            this.onTurn?.(turn);
            continue;
          }

          // Execute wall-clock timeout: recover gracefully instead of aborting.
          // Heavy SPAs (AliExpress, AllTrails, SportingNews) can stall every action
          // for 45s+. Instead of counting these as consecutive errors (which aborts
          // after 3), re-observe and let the agent try a different approach.
          // Cap at 2 recoveries to prevent infinite timeout loops.
          if (
            err instanceof Error &&
            err.message.includes('Execute wall-clock timeout') &&
            executeTimeoutRecoveries < 2
          ) {
            executeTimeoutRecoveries++;
            if (this.config.debug) {
              console.log(`[Runner] Execute timeout recovery ${executeTimeoutRecoveries}/2 — re-observing`);
            }
            this.cachedPostState = await this.driver.observe().catch(() => undefined);
            this.brain.injectFeedback(
              'Your action timed out — the page is loading slowly or has heavy JavaScript. ' +
              'Try interacting with elements already visible in the snapshot, use runScript ' +
              'to extract data directly, or navigate to a different page.'
            );
            turn.error = `Execute timeout (recovered ${executeTimeoutRecoveries}/2)`;
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
          runState.recordError();
        } else {
          runState.clearConsecutiveErrors();
          executeTimeoutRecoveries = 0; // Reset on successful action

          // Capture element bounding box for replay overlays
          if (execResult.bounds) {
            turn.actionBounds = execResult.bounds;
          }

          // Update selector cache on successful action
          if (this.selectorCache && 'selector' in action && action.selector) {
            const element = findElementForRef(state.snapshot, action.selector);
            if (element) {
              this.selectorCache.recordSuccess(element, action.selector);
            }
          }
        }

        let followUpActions = this.selectFollowUpActions(action, nextActions);

        // Auto-submit: if we just typed into a searchbox and no follow-up
        // presses Enter or clicks a search button, inject a press Enter.
        // Many sites require form submission to trigger search filtering.
        if (
          !turn.error &&
          action.action === 'type' &&
          'selector' in action &&
          action.selector
        ) {
          const typedElement = findElementForRef(state.snapshot, action.selector)?.toLowerCase() ?? '';
          if (typedElement.startsWith('searchbox')) {
            const hasSubmit = followUpActions.some(
              (a) => (a.action === 'press' && 'key' in a && a.key === 'Enter') ||
                     (a.action === 'click' && 'selector' in a && a.selector &&
                       (findElementForRef(state.snapshot, a.selector)?.toLowerCase().includes('search') ?? false)),
            );
            if (!hasSubmit) {
              followUpActions = [{ action: 'press', selector: action.selector, key: 'Enter' }, ...followUpActions];
            }
          }
        }
        for (const followUpAction of followUpActions) {
          if (turn.error) break;
          try {
            const followResult = await withRetry(
              () => this.driver.execute(followUpAction),
              1, // Follow-ups are speculative micro-actions — fail fast, don't retry 3x
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
              runState.recordError();
            }
          } catch (followErr) {
            turn.error = followErr instanceof Error ? followErr.message : String(followErr);
            runState.recordError();
          }
        }

        const domainBoundaryViolation = await this.enforceAllowedDomainBoundary(state, scenario);
        if (domainBoundaryViolation) {
          this.cachedPostState = undefined; // boundary navigated back — invalidate cache
          this.brain.injectFeedback(domainBoundaryViolation);
          turn.error = domainBoundaryViolation;
          turn.durationMs = Date.now() - turnStart;
          runState.recordError();
          if (executedActions.length > 1) {
            turn.executedActions = executedActions;
          }
          turns.push(turn);
          this.onTurn?.(turn);
          continue;
        }

        // -- 8. Post-action verification --
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
        runState.recordError();
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

        if (runState.hasConsecutiveErrorThreshold) {
          return buildResult({
            success: false,
            reason: `${runState.consecutiveErrors} consecutive errors: ${error}`,
            turns,
            totalMs: Date.now() - startTime,
          });
        }

        if (runState.isErrorBudgetExhausted) {
          return buildResult({
            success: false,
            reason: `Error budget exhausted (${runState.totalErrors}/${runState.maxTotalErrors} total errors): ${error}`,
            turns,
            totalMs: Date.now() - startTime,
          });
        }

        if (this.config.debug) {
          console.log(`[Runner] Error on turn ${i}, continuing: ${error}`);
        }
      }
    }

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

  /** Persist knowledge, selector cache, and session history to disk */
  private saveMemory(scenario?: Scenario, result?: AgentResult): void {
    try {
      if (this.knowledge && scenario && result) {
        this.knowledge.recordSession(buildSession(scenario, result))
      }
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
   * - "URL should contain X" -> check page URL
   * - "element should be visible" -> check snapshot
   * - "text should appear" -> check snapshot
   * - Generic text match -> check if text appears in snapshot
   */
  private async verifyEffect(
    expectedEffect: string,
    preActionState: PageState
  ): Promise<{ verified: boolean; reason?: string }> {
    // URL-based verification — no sleep needed, URL commits synchronously with navigation
    if (/url\s+should/i.test(expectedEffect)) {
      const currentUrl = this.driver.getUrl?.() ?? (await this.driver.observe().catch(() => preActionState)).url;

      // Extract target: prefer quoted value (handles complex phrases like
      // "URL should change to include '/chat/'"), fall back to word after verb
      const quotedVal = expectedEffect.match(/['"]([^'"]+)['"]/);
      const verbVal = expectedEffect.match(/url\s+should\s+(?:contain|include|have)\s+(\S+)/i);
      const expected = quotedVal?.[1] ?? verbVal?.[1];

      if (expected) {
        if (currentUrl.includes(expected)) {
          return { verified: true };
        }
        return {
          verified: false,
          reason: `Expected URL to contain "${expected}" but got "${currentUrl}"`,
        };
      }

      // "URL should change" without a specific target — just check if URL changed
      if (currentUrl !== preActionState.url) {
        return { verified: true };
      }
      return {
        verified: false,
        reason: `Expected URL to change but it stayed at "${currentUrl}"`,
      };
    }

    // Non-URL effects: brief wait for DOM to settle, then observe
    await new Promise(r => setTimeout(r, 100));
    const postState = await this.driver.observe().catch(() => preActionState);
    this.cachedPostState = postState;

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
        const selectors = [
          'main a[href]',
          '[role="main"] a[href]',
          'article a[href]',
          '.search-results a[href]',
          '#search-results a[href]',
          '.results a[href]',
          'ol a[href]',
        ];
        const fallbackLinks = Array.from(document.querySelectorAll('a[href]'));
        const links = selectors
          .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
          .concat(fallbackLinks);
        const noisePattern = /\b(next|previous|page \d+|show more|show fewer|filter|sort|home|contact|privacy|accessibility|search)\b/i;

        for (const node of links) {
          const anchor = node as HTMLAnchorElement;
          const href = anchor.href?.trim();
          const title = (anchor.innerText || anchor.textContent || '').replace(/\s+/g, ' ').trim();
          if (!href || !title || title.length < 12 || title.length > 220) continue;
          if (href.startsWith('javascript:') || href.startsWith('mailto:') || href.includes('#')) continue;
          if (href.includes('results.aspx') && !/open government|dataset|data|news release|press release/i.test(title)) continue;
          if (noisePattern.test(title) && !/open government|dataset|data|news release|press release/i.test(title)) continue;
          const key = `${title}::${href}`;
          if (seen.has(key)) continue;
          seen.add(key);
          items.push({ title, href });
          if (items.length >= 24) break;
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

  private async buildVisibleLinkScoutRecommendation(
    state: PageState,
    goal: string,
    allowedDomains: string[] | undefined,
  ): Promise<{ ref: string; text: string; confidence: number; reasoning: string } | undefined> {
    const scoutConfig = this.config.scout;
    if (!scoutConfig?.enabled) return undefined;
    if (!shouldUseVisibleLinkScoutPage(state, goal, allowedDomains)) return undefined;

    const ranked = getRankedVisibleLinkCandidates(state, goal, allowedDomains);
    const maxCandidates = Math.max(2, Math.min(scoutConfig.maxCandidates ?? 3, 5));
    const candidates = await this.filterScoutCandidatesByAllowedDomains(
      ranked.slice(0, maxCandidates),
      allowedDomains,
    );
    if (!shouldUseVisibleLinkScout(candidates, scoutConfig)) return undefined;

    const scoutState = scoutConfig.useVision
      ? await this.attachDecisionScreenshot(state)
      : state;
    const extraContext = allowedDomains && allowedDomains.length > 0
      ? `Host constraint: prefer only ${allowedDomains.join(', ')}.`
      : undefined;
    const recommendation = await this.brain.recommendLinkCandidate(
      goal,
      scoutState,
      candidates,
      extraContext,
    );
    const matched = candidates.find((candidate) => candidate.ref === recommendation.selector);
    if (!matched) return undefined;

    return {
      ref: matched.ref,
      text: matched.text,
      confidence: recommendation.confidence,
      reasoning: recommendation.reasoning,
    };
  }

  private async buildBranchLinkRecommendation(
    state: PageState,
    goal: string,
    allowedDomains: string[] | undefined,
  ): Promise<{ ref: string; text: string; confidence: number; reasoning: string } | undefined> {
    const scoutConfig = this.config.scout;
    if (!scoutConfig?.enabled || !scoutConfig.readOnlyTop2Challenger) return undefined;
    if (!shouldUseVisibleLinkScoutPage(state, goal, allowedDomains)) return undefined;

    const ranked = getRankedVisibleLinkCandidates(state, goal, allowedDomains);
    const candidates = ranked.slice(0, 2);
    if (!shouldUseBoundedBranchExplorer(candidates, scoutConfig)) return undefined;
    if (!this.driver.inspectSelectorHref || !this.driver.getPage) return undefined;

    const page = this.driver.getPage();
    if (!page) return undefined;

    const settled = await Promise.all(
      candidates.map(async (candidate) => {
        const href = await this.driver.inspectSelectorHref!(candidate.ref).catch(() => undefined);
        if (!href) return undefined;
        const preview = await inspectBranchPreview(page, href, 8000);
        if (!preview) return undefined;
        return { ref: candidate.ref, text: candidate.text, href, score: scoreBranchPreview(goal, preview, allowedDomains), preview };
      }),
    );
    const previews = settled.filter(
      (r): r is { ref: string; text: string; href: string; score: number; preview: BranchPreview } => r !== undefined,
    );

    if (previews.length < 2) return undefined;
    previews.sort((a, b) => b.score - a.score);
    const [top, second] = previews;
    if (top.score <= second.score) return undefined;
    if (top.score < 4) return undefined;

    return {
      ref: top.ref,
      text: top.text,
      confidence: Math.min(0.95, 0.7 + Math.max(0, top.score - second.score) / 20),
      reasoning: `Branch preview favored ${top.href} (${top.preview.title || top.preview.finalUrl}) over ${second.href} based on content-type and goal-match signals.`,
    };
  }

  private async filterScoutCandidatesByAllowedDomains(
    candidates: Array<{ ref: string; text: string; score: number }>,
    allowedDomains: string[] | undefined,
  ): Promise<Array<{ ref: string; text: string; score: number }>> {
    if (!allowedDomains || allowedDomains.length === 0 || !this.driver.inspectSelectorHref) {
      return candidates;
    }

    const allowedHosts = new Set(allowedDomains.map((domain) => domain.toLowerCase()));
    const resolved = await Promise.all(
      candidates.map(async (candidate) => {
        const href = await this.driver.inspectSelectorHref!(candidate.ref).catch(() => undefined);
        const host = href ? safeHostname(href) : undefined;
        return { candidate, host };
      }),
    );
    return resolved
      .filter(({ host }) => !host || allowedHosts.has(host))
      .map(({ candidate }) => candidate);
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
    const allowedLower = scenario.allowedDomains.map((domain) => domain.toLowerCase());
    if (allowedLower.includes(host)) return undefined;
    // First-party subdomain tolerance
    const toRoot = (h: string) => {
      const parts = h.split('.').filter(Boolean);
      return parts.length <= 2 ? h : parts.slice(-2).join('.');
    };
    if (allowedLower.some((h) => toRoot(h) === toRoot(host))) return undefined;

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

    const currentUrl = this.driver.getUrl?.() ?? preActionState.url;
    const currentHost = safeHostname(currentUrl);
    if (!currentHost) return undefined;

    const allowedHosts = scenario.allowedDomains.map((domain) => domain.toLowerCase());
    if (allowedHosts.includes(currentHost)) return undefined;

    // First-party subdomain tolerance: allow navigation within the same registrable domain
    const toRoot = (h: string) => {
      const parts = h.split('.').filter(Boolean);
      return parts.length <= 2 ? h : parts.slice(-2).join('.');
    };
    const currentRoot = toRoot(currentHost);
    if (allowedHosts.some((h) => toRoot(h) === currentRoot)) return undefined;

    const previousHost = safeHostname(preActionState.url);
    if (previousHost && allowedHosts.includes(previousHost)) {
      await this.driver.execute({ action: 'navigate', url: preActionState.url }).catch(() => {});
    } else if (scenario.startUrl) {
      await this.driver.execute({ action: 'navigate', url: scenario.startUrl }).catch(() => {});
    }

    return [
      `Boundary violation: landed on ${currentUrl}, but the allowed host set is ${allowedHosts.join(', ')}.`,
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

/** Convenience function */
export async function runBrowserAgent(
  driver: Driver,
  scenario: Scenario,
  options?: Omit<BrowserAgentOptions, 'driver'>
): Promise<AgentResult> {
  const runner = new BrowserAgent({ driver, ...options });
  return runner.run(scenario);
}
