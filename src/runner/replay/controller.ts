/**
 * Workflow Replay — the IO executor.
 *
 * Drives the live driver + the pure {@link ReplayGuard} through a
 * {@link ReplayPlan} with ZERO per-action LLM calls. Per step:
 *   observe → guard.check (abort → heal) → driver.execute (error → heal) →
 *   verify expected effect when present (fail → heal).
 * After every step replays cleanly, a single {@link ReplayContext.verifyGoal}
 * call (the only permitted model round-trip) decides whether the goal was
 * actually achieved — replay never blindly claims success.
 *
 * The first guard/execute/effect failure ABORTS into a `healed` outcome carrying
 * the live page state, so the runner resumes its per-action loop from exactly
 * where replay stopped. A wrong replay therefore costs at most a handful of fast
 * browser actions before control returns to the agent.
 */

import type { PageState } from '../../types/page.js';
import type { Turn } from '../../types/turn.js';
import type {
  ReplayContext,
  ReplayController,
  ReplayOutcome,
  ReplayPlan,
  ReplayStep,
} from './contracts.js';

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hasStateChanged(pre: PageState, post: PageState): boolean {
  return pre.url !== post.url || pre.title !== post.title || pre.snapshot !== post.snapshot;
}

function buildTurn(
  turnNumber: number,
  state: PageState,
  step: ReplayStep,
  extra: {
    verified?: boolean;
    expectedEffect?: string;
    verificationFailure?: string;
    error?: string;
    durationMs: number;
  },
): Turn {
  return {
    turn: turnNumber,
    state,
    action: step.action,
    reasoning: 'workflow-replay (zero-LLM)',
    durationMs: extra.durationMs,
    ...(extra.expectedEffect !== undefined ? { expectedEffect: extra.expectedEffect } : {}),
    ...(extra.verified !== undefined ? { verified: extra.verified } : {}),
    ...(extra.verificationFailure !== undefined ? { verificationFailure: extra.verificationFailure } : {}),
    ...(extra.error !== undefined ? { error: extra.error } : {}),
  };
}

function buildClaim(plan: ReplayPlan, finalState: PageState, completedSteps: number): string {
  return (
    `Replayed ${completedSteps} recorded step(s) from a prior successful run of a ` +
    `near-identical goal (similarity ${plan.goalSimilarity.toFixed(2)}). ` +
    `Final page: ${finalState.url} — "${finalState.title}".`
  );
}

/** Default {@link ReplayController}: self-healing, zero per-action LLM calls. */
export class SelfHealingReplayController implements ReplayController {
  async replay(plan: ReplayPlan, ctx: ReplayContext): Promise<ReplayOutcome> {
    const totalSteps = plan.steps.length;
    const turns: Turn[] = [];

    ctx.onEvent?.({
      type: 'replay-started',
      trajectoryId: plan.trajectory.id,
      totalSteps,
      goalSimilarity: plan.goalSimilarity,
    });

    // Defensive: a plan with no steps can't be replayed. (The store filters
    // empty trajectories out of findReplayCandidate, so this is a guard rail.)
    if (totalSteps === 0) {
      const lastState = (await this.safeObserve(ctx)) ?? this.minimalState(ctx);
      return this.heal(ctx, turns, 0, totalSteps, lastState, 'replay plan had no steps');
    }

    let lastState: PageState | undefined;

    for (let index = 0; index < totalSteps; index++) {
      const step = plan.steps[index];
      ctx.onEvent?.({ type: 'replay-step', index, totalSteps, action: step.action.action });

      // -- observe current state (also the turn.state for this step) --
      let preState: PageState;
      try {
        preState = await ctx.driver.observe();
      } catch (err) {
        const recover = lastState ?? this.minimalState(ctx);
        return this.heal(ctx, turns, index, totalSteps, recover, `observe failed before step ${index + 1}: ${errMsg(err)}`);
      }
      lastState = preState;

      // Cooperative cancellation — surface as a heal so the runner's own
      // abort check finalizes the run.
      if (ctx.signal?.aborted) {
        const reason = ctx.signal.reason ? String(ctx.signal.reason) : 'cancelled';
        return this.heal(ctx, turns, index, totalSteps, preState, reason);
      }

      // -- pure guard: can this step still be performed? --
      const guardResult = ctx.guard.check(step, { url: preState.url, snapshot: preState.snapshot });
      if (guardResult.decision === 'abort') {
        ctx.onEvent?.({ type: 'replay-guard-abort', index, reason: guardResult.reason });
        return this.heal(ctx, turns, index, totalSteps, preState, guardResult.reason);
      }

      // -- execute --
      const stepStartedAt = Date.now();
      let execError: string | undefined;
      try {
        const result = await ctx.driver.execute(step.action);
        if (!result.success) execError = result.error ?? 'action reported failure';
      } catch (err) {
        execError = errMsg(err);
      }
      if (execError) {
        // Record the attempted (errored) turn so the timeline shows what was
        // tried, then heal. This is the one case where turns.length exceeds
        // completedSteps (the contract documents this).
        turns.push(buildTurn(turns.length + 1, preState, step, {
          verified: false,
          error: execError,
          durationMs: Date.now() - stepStartedAt,
          ...(step.expectedEffect !== undefined ? { expectedEffect: step.expectedEffect } : {}),
        }));
        return this.heal(ctx, turns, index, totalSteps, preState, `execute failed at step ${index + 1}: ${execError}`);
      }

      // -- observe post-state + verify the recorded effect when present --
      let postState: PageState;
      try {
        postState = await ctx.driver.observe();
      } catch {
        postState = preState;
      }
      lastState = postState;

      let verified: boolean;
      if (step.expectedEffect) {
        const ev = ctx.verifyEffect({
          expectedEffect: step.expectedEffect,
          preActionState: preState,
          postActionState: postState,
        });
        verified = ev.verified;
        if (!ev.verified) {
          const reason = ev.reason ?? 'expected effect not observed';
          turns.push(buildTurn(turns.length + 1, preState, step, {
            verified: false,
            expectedEffect: step.expectedEffect,
            verificationFailure: reason,
            durationMs: Date.now() - stepStartedAt,
          }));
          ctx.onEvent?.({ type: 'replay-effect-failed', index, reason });
          return this.heal(ctx, turns, index, totalSteps, postState, `effect verification failed at step ${index + 1}: ${reason}`);
        }
      } else {
        // No persisted effect — fall back to change-detection for the
        // diagnostic `verified` flag only. Absence of change is NOT a heal
        // signal: typing into a field or an idempotent click can leave the
        // snapshot materially unchanged. The guard pre-check + execute-success
        // + final goal verification remain the safety net here.
        verified = hasStateChanged(preState, postState);
      }

      turns.push(buildTurn(turns.length + 1, preState, step, {
        verified,
        durationMs: Date.now() - stepStartedAt,
        ...(step.expectedEffect !== undefined ? { expectedEffect: step.expectedEffect } : {}),
      }));
    }

    // -- all steps replayed: the single permitted LLM round-trip --
    const finalState = (await this.safeObserve(ctx)) ?? lastState ?? this.minimalState(ctx);
    const finalResult = buildClaim(plan, finalState, totalSteps);
    const goalVerification = await ctx.verifyGoal(finalState, ctx.goal, finalResult);
    ctx.onEvent?.({ type: 'replay-completed', completedSteps: totalSteps, achieved: goalVerification.achieved });

    return {
      kind: 'completed',
      completedSteps: totalSteps,
      totalSteps,
      llmCallsUsed: 1,
      turns,
      lastState: finalState,
      goalVerification,
      finalResult,
    };
  }

  private heal(
    ctx: ReplayContext,
    turns: Turn[],
    completedSteps: number,
    totalSteps: number,
    lastState: PageState,
    reason: string,
  ): ReplayOutcome {
    ctx.onEvent?.({ type: 'replay-healed', completedSteps, totalSteps, reason });
    if (ctx.debug) {
      console.log(`[Replay] healed after ${completedSteps}/${totalSteps} steps: ${reason}`);
    }
    return {
      kind: 'healed',
      completedSteps,
      totalSteps,
      llmCallsUsed: 0,
      turns,
      lastState,
      reason,
    };
  }

  private async safeObserve(ctx: ReplayContext): Promise<PageState | undefined> {
    try {
      return await ctx.driver.observe();
    } catch {
      return undefined;
    }
  }

  private minimalState(ctx: ReplayContext): PageState {
    return { url: ctx.driver.getUrl?.() ?? '', title: '', snapshot: '' };
  }
}

/** Factory mirroring the rest of the replay module's construction style. */
export function createReplayController(): ReplayController {
  return new SelfHealingReplayController();
}
