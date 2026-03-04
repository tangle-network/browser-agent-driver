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
import type { Scenario, AgentConfig, AgentResult, Turn, PageState } from './types.js';
import { analyzeRecovery } from './recovery.js';
import { StaleRefError, AriaSnapshotHelper } from './drivers/snapshot.js';
import { verifyPreview } from './preview.js';
import type { ProjectStore } from './memory/project-store.js';
import { AppKnowledge } from './memory/knowledge.js';
import { SelectorCache } from './memory/selectors.js';

const DEFAULT_MAX_TURNS = 20;
const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;

export interface RunnerOptions {
  driver: Driver;
  config?: AgentConfig;
  /** Called after each turn */
  onTurn?: (turn: Turn) => void;
  /** Reference trajectory to inject into brain context */
  referenceTrajectory?: string;
  /** Project memory store — enables knowledge + selector persistence */
  projectStore?: ProjectStore;
}

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
  private referenceTrajectory?: string;
  private projectStore?: ProjectStore;
  private knowledge?: AppKnowledge;
  private selectorCache?: SelectorCache;

  constructor(options: RunnerOptions) {
    this.driver = options.driver;
    this.config = options.config || {};
    this.brain = new Brain(this.config);
    this.onTurn = options.onTurn;
    this.referenceTrajectory = options.referenceTrajectory;
    this.projectStore = options.projectStore;
  }

  async run(scenario: Scenario): Promise<AgentResult> {
    const maxTurns = scenario.maxTurns || DEFAULT_MAX_TURNS;
    const retries = this.config.retries ?? DEFAULT_RETRIES;
    const retryDelayMs = this.config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const turns: Turn[] = [];
    const startTime = Date.now();

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
      await withRetry(
        () => this.driver.execute({ action: 'navigate', url: scenario.startUrl! }),
        retries,
        retryDelayMs,
        undefined,
        scenario.signal,
      );
    }

    let consecutiveErrors = 0;
    let totalErrors = 0;
    const maxTotalErrors = Math.max(3, Math.ceil(maxTurns / 3));

    for (let i = 1; i <= maxTurns; i++) {
      if (scenario.signal?.aborted) {
        return {
          success: false,
          reason: scenario.signal.reason || 'Cancelled',
          turns,
          totalMs: Date.now() - startTime,
        };
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

        // ── 3. Build extra context ──
        let extraContext = '';
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

        // ── 4. Decide (with retry) ──
        const decision = await withRetry(
          () => this.brain.decide(scenario.goal, state, extraContext || undefined, { current: i, max: maxTurns }),
          retries,
          retryDelayMs,
          (attempt, err) => {
            if (this.config.debug) {
              console.log(`[Runner] LLM retry ${attempt}: ${err.message}`);
            }
          },
          scenario.signal,
        );

        const { action, raw, reasoning, plan, currentStep, expectedEffect, tokensUsed } = decision;

        const turn: Turn = {
          turn: i,
          state,
          action,
          rawLLMResponse: raw,
          reasoning,
          plan,
          currentStep,
          expectedEffect,
          tokensUsed,
          durationMs: Date.now() - turnStart,
        };

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
              action.result || '',
            );

            if (this.config.debug) {
              console.log(`[Runner] Goal verification: achieved=${goalResult.achieved}, confidence=${goalResult.confidence}`);
            }

            if (!goalResult.achieved) {
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
            return {
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
            };
          }

          // Goal verified (or skipped), no quality gate
          turns.push(turn);
          this.onTurn?.(turn);
          this.saveMemory();
          return {
            success: true,
            result: action.result,
            turns,
            totalMs: Date.now() - startTime,
            goalVerification: goalResult,
          };
        }

        if (action.action === 'abort') {
          turns.push(turn);
          this.onTurn?.(turn);
          this.saveMemory();
          return {
            success: false,
            reason: action.reason,
            turns,
            totalMs: Date.now() - startTime,
          };
        }

        // ── 7. Execute (with stale-ref auto-retry) ──
        let execResult: Awaited<ReturnType<Driver['execute']>>;
        try {
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
          return {
            success: false,
            reason: `${consecutiveErrors} consecutive errors: ${error}`,
            turns,
            totalMs: Date.now() - startTime,
          };
        }

        if (totalErrors >= maxTotalErrors) {
          this.saveMemory();
          return {
            success: false,
            reason: `Error budget exhausted (${totalErrors}/${maxTotalErrors} total errors): ${error}`,
            turns,
            totalMs: Date.now() - startTime,
          };
        }

        if (this.config.debug) {
          console.log(`[Runner] Error on turn ${i}, continuing: ${error}`);
        }
      }
    }

    // Persist memory before returning
    this.saveMemory();

    // Max turns reached
    return {
      success: false,
      reason: `Max turns (${maxTurns}) reached`,
      turns,
      totalMs: Date.now() - startTime,
    };
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
