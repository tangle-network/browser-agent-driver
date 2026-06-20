/**
 * Deterministic plan execution: the runner loop's replan path hands a Plan to
 * this helper, which drives each step through the driver and verifies the
 * post-condition without re-entering the LLM between steps.
 *
 * Extracted from runner.ts via the delegate + host-interface pattern. The
 * BrowserAgent class keeps a thin delegator (`executePlan`); this free function
 * holds the method body verbatim and reads runner state through
 * {@link RunnerExecuteHost}, which BrowserAgent `implements` so tsc proves the
 * host surface is complete. Behavior is byte-identical to the inlined version —
 * same ordering, event emissions, auto-pass list, verification thresholds, and
 * fall-through reasons.
 */

import type { Driver } from '../drivers/types.js';
import type { AgentConfig, PageState, Plan, Scenario, Turn } from '../types.js';
import { RunState } from '../run-state.js';
import type { TurnEventBus } from './events.js';

import { hasPlaceholderPattern, isMeaningfulRunScriptOutput } from './completion-policy.js';
import { pushGoalVerificationEvidence } from './utils.js';
import { verifyExpectedEffect } from './effect-verification.js';

/**
 * The slice of runner state plan execution reads. The BrowserAgent class
 * declares `implements RunnerExecuteHost`, so a missing or mistyped member is a
 * compile error — this interface IS the safety gate for the extraction. All
 * members are public on BrowserAgent by construction.
 */
export interface RunnerExecuteHost {
  driver: Driver;
  config: AgentConfig;
  bus: TurnEventBus;
  onTurn?: (turn: Turn) => void;
  cachedPostState: PageState | undefined;
}

export async function executePlanImpl(
  self: RunnerExecuteHost,
  plan: Plan,
  scenario: Scenario,
  runId: string,
  turns: Turn[],
  runState: RunState,
  startingTurnIndex: number,
  /**
   * Token usage from the Brain.plan() LLM call that produced this plan.
   * The plan call's tokens are NOT attached to any per-step turn — there's
   * one plan call per N steps. To make the run-level cost tally honest,
   * we attribute the plan call to the FIRST step's Turn artifact so the
   * downstream sum (in baseline-summary.json / report.json) reflects the
   * real LLM spend.
   */
  planCallTokens?: {
    tokensUsed?: number
    inputTokens?: number
    outputTokens?: number
    cacheReadInputTokens?: number
    cacheCreationInputTokens?: number
  },
): Promise<
  | { kind: 'completed'; lastState: PageState; finalResult?: string; turnsConsumed: number }
  | { kind: 'deviated'; lastState: PageState; failedStepIndex: number; reason: string; turnsConsumed: number }
> {
  let currentTurnIndex = startingTurnIndex
  let lastState: PageState = turns[turns.length - 1]?.state
    ?? { url: '', title: '', snapshot: '' }

  // Track the last successful runScript output so placeholder complete
  // results can be substituted with the real script output.
  let lastRunScriptOutput: string | null = null

  // Track extractWithIndex matches for per-action fallback; the LLM must
  // read the list and pick by index.
  let lastExtractOutput: string | null = null

  for (let stepIdx = 0; stepIdx < plan.steps.length; stepIdx++) {
    if (scenario.signal?.aborted) {
      return {
        kind: 'deviated',
        lastState,
        failedStepIndex: stepIdx,
        reason: scenario.signal.reason || 'Cancelled',
        turnsConsumed: stepIdx,
      }
    }

    const step = plan.steps[stepIdx]
    const stepStartedAt = Date.now()
    const turnNumber = currentTurnIndex + 1
    currentTurnIndex++

    // Refresh the snapshot before EVERY step. The plan was built from a
    // single observe() call at turn 1; later steps may target a different
    // page entirely (after navigate / click "Next"). The first observe
    // here is also what verify-against will eventually consume.
    const preStepState = await self.driver.observe().catch(() => lastState)
    lastState = preStepState

    // Wrap each plan step in a Turn artifact so post-run analysis (the
    // viewer, the events.jsonl persistence, the metrics) sees a unified
    // timeline regardless of whether the runner used the planner or the
    // per-action loop.
    //
    // Token attribution: the first step carries the Brain.plan() LLM call's
    // token usage so run-level cost includes planning.
    const isFirstStep = stepIdx === 0
    const turn: Turn = {
      turn: turnNumber,
      state: preStepState,
      action: step.action,
      reasoning: step.rationale ?? `Plan step ${stepIdx + 1}/${plan.steps.length}`,
      expectedEffect: step.expectedEffect,
      plan: plan.steps.map((s) => s.rationale ?? s.action.action),
      currentStep: stepIdx,
      durationMs: 0,
      ...(isFirstStep && planCallTokens?.tokensUsed !== undefined ? { tokensUsed: planCallTokens.tokensUsed } : {}),
      ...(isFirstStep && planCallTokens?.inputTokens !== undefined ? { inputTokens: planCallTokens.inputTokens } : {}),
      ...(isFirstStep && planCallTokens?.outputTokens !== undefined ? { outputTokens: planCallTokens.outputTokens } : {}),
      ...(isFirstStep && planCallTokens?.cacheReadInputTokens !== undefined ? { cacheReadInputTokens: planCallTokens.cacheReadInputTokens } : {}),
      ...(isFirstStep && planCallTokens?.cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens: planCallTokens.cacheCreationInputTokens } : {}),
    }

    // Terminal actions: complete and abort don't go through driver.execute
    // — the runner handles them as the end of the plan.
    if (step.action.action === 'complete') {
      // Substitute placeholder complete results with prior runScript output.
      let resolvedResult = step.action.result
      if (
        lastRunScriptOutput
        && typeof resolvedResult === 'string'
        && hasPlaceholderPattern(resolvedResult)
      ) {
        if (self.config.debug) {
          console.log(`[Runner] Substituting placeholder complete.result with runScript output (${lastRunScriptOutput.length} chars)`)
        }
        resolvedResult = lastRunScriptOutput
        turn.reasoning = `${turn.reasoning ?? ''} [substituted runScript output]`.trim()
      }
      turn.durationMs = Date.now() - stepStartedAt
      turns.push(turn)
      self.onTurn?.(turn)
      self.bus.emitNow({
        type: 'plan-step-executed',
        runId,
        turn: turnNumber,
        stepIndex: stepIdx + 1,
        totalSteps: plan.steps.length,
        action: step.action,
        executeSuccess: true,
        verified: true,
        durationMs: turn.durationMs,
      })
      return {
        kind: 'completed',
        lastState,
        finalResult: resolvedResult,
        turnsConsumed: stepIdx + 1,
      }
    }
    if (step.action.action === 'abort') {
      turn.durationMs = Date.now() - stepStartedAt
      turns.push(turn)
      self.onTurn?.(turn)
      self.bus.emitNow({
        type: 'plan-deviated',
        runId,
        turn: turnNumber,
        stepIndex: stepIdx + 1,
        totalSteps: plan.steps.length,
        reason: `plan aborted: ${step.action.reason}`,
      })
      return {
        kind: 'deviated',
        lastState,
        failedStepIndex: stepIdx,
        reason: `plan aborted: ${step.action.reason}`,
        turnsConsumed: stepIdx + 1,
      }
    }

    // Execute the action via the existing driver path. This emits
    // execute-started / execute-completed events on the bus exactly
    // like the per-action loop does.
    //
    // Cap each plan step at 10s so missing selectors fail quickly and hand
    // control back to per-action mode.
    self.bus.emitNow({ type: 'execute-started', runId, turn: turnNumber, action: step.action })
    const execStartedAt = Date.now()
    const planStepTimeoutMs = 10_000
    let execResult: Awaited<ReturnType<Driver['execute']>>
    try {
      execResult = await Promise.race([
        self.driver.execute(step.action),
        new Promise<Awaited<ReturnType<Driver['execute']>>>((resolve) =>
          setTimeout(
            () => resolve({ success: false, error: `plan step wall-clock timeout after ${planStepTimeoutMs}ms` }),
            planStepTimeoutMs,
          ),
        ),
      ])
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      execResult = { success: false, error: message }
    }
    const execDurationMs = Date.now() - execStartedAt
    self.bus.emitNow({
      type: 'execute-completed',
      runId,
      turn: turnNumber,
      action: step.action,
      success: execResult.success,
      ...(execResult.error ? { error: execResult.error } : {}),
      ...(execResult.bounds ? { bounds: execResult.bounds } : {}),
      durationMs: execDurationMs,
    })

    if (!execResult.success) {
      turn.error = execResult.error
      turn.durationMs = Date.now() - stepStartedAt
      turn.verified = false
      turn.verificationFailure = `execute failed: ${execResult.error}`
      turns.push(turn)
      self.onTurn?.(turn)
      runState.recordError()
      self.bus.emitNow({
        type: 'plan-step-executed',
        runId,
        turn: turnNumber,
        stepIndex: stepIdx + 1,
        totalSteps: plan.steps.length,
        action: step.action,
        executeSuccess: false,
        verified: false,
        durationMs: Date.now() - stepStartedAt,
        ...(execResult.error ? { verifyReason: execResult.error } : {}),
      })
      self.bus.emitNow({
        type: 'plan-deviated',
        runId,
        turn: turnNumber,
        stepIndex: stepIdx + 1,
        totalSteps: plan.steps.length,
        reason: `execute failed: ${execResult.error}`,
      })
      return {
        kind: 'deviated',
        lastState,
        failedStepIndex: stepIdx,
        reason: `execute failed at step ${stepIdx + 1}: ${execResult.error}`,
        turnsConsumed: stepIdx + 1,
      }
    }

    runState.clearConsecutiveErrors()
    if (execResult.bounds) turn.actionBounds = execResult.bounds

    // Capture runScript output for placeholder substitution and evidence.
    if (step.action.action === 'runScript' && typeof execResult.data === 'string' && execResult.data.length > 0) {
      lastRunScriptOutput = execResult.data
      if (execResult.data.length > 10) {
        runState.recordEvidence(`EXTRACTED (turn ${currentTurnIndex}): ${execResult.data.slice(0, 500)}`)
      }
    }

    // Capture extractWithIndex output for per-action fallback.
    if (step.action.action === 'extractWithIndex' && typeof execResult.data === 'string' && execResult.data.length > 0) {
      lastExtractOutput = execResult.data
      // Also push as goal verification evidence so the verifier sees what
      // the agent extracted.
      runState.firstSufficientEvidenceTurn ??= currentTurnIndex
      pushGoalVerificationEvidence(runState.goalVerificationEvidence, `EXTRACT RESULT:\n${execResult.data}`)
      if (execResult.data.length > 10) {
        runState.recordEvidence(`EXTRACTED (turn ${currentTurnIndex}): ${execResult.data.slice(0, 500)}`)
      }
    }

    // Verify the post-condition. We re-observe to get the post-action
    // state, then run the same verifyExpectedEffect helper the per-action
    // loop uses. The fresh observe is also stashed in cachedPostState so
    // the next step's pre-step observe can reuse it.
    self.bus.emitNow({
      type: 'verify-started',
      runId,
      turn: turnNumber,
      expectedEffect: step.expectedEffect,
    })
    const verifyStartedAt = Date.now()
    // Auto-pass list — these actions either don't observably mutate
    // the page state OR they're self-verifying (the underlying Playwright
    // call throws on real failure, so a successful return means the
    // mutation actually happened). Strict expectedEffect verification
    // would generate false negatives on the per-action loop fallback for
    // these. Plan execution trusts the execute result.
    //
    // - wait / scroll / hover: don't mutate observable snapshot state
    // - runScript / evaluate / verifyPreview: meta actions
    // - fill / clickSequence: self-verifying (Playwright throws on miss),
    //   AND input values don't always reflect in the ARIA snapshot, so
    //   the permissive "did state change?" check would also miss them
    const isAutoPass =
      step.action.action === 'wait'
      || step.action.action === 'scroll'
      || step.action.action === 'hover'
      || step.action.action === 'runScript'
      || step.action.action === 'extractWithIndex'
      || step.action.action === 'evaluate'
      || step.action.action === 'verifyPreview'
      || step.action.action === 'fill'
      || step.action.action === 'clickSequence'
    // Settle wait for mutating actions, mirroring verifyEffect's logic
    const needsSettleWait = step.action.action === 'click'
      || step.action.action === 'navigate'
      || step.action.action === 'press'
      || step.action.action === 'select'
      || step.action.action === 'fill'
      || step.action.action === 'clickSequence'
    const observePromise = self.driver.observe().catch(() => preStepState)
    if (needsSettleWait) {
      await Promise.all([
        observePromise,
        new Promise((r) => setTimeout(r, 50)),
      ])
    }
    const postStepState = await observePromise
    self.cachedPostState = postStepState
    lastState = postStepState

    // Plan verification is more permissive than per-action verification:
    // a step passes if (a) it's a non-mutating action, OR (b) the strict
    // verifier passes, OR (c) the snapshot/url changed in any meaningful
    // way (the action did SOMETHING). Strict failure-on-no-change is
    // appropriate for the per-action loop where the agent can recover,
    // but plan execution needs to push forward unless there's positive
    // evidence of failure.
    let verifyResult: { verified: boolean; reason?: string }
    if (isAutoPass) {
      verifyResult = { verified: true }
    } else {
      const strictResult = verifyExpectedEffect({
        expectedEffect: step.expectedEffect,
        preActionState: preStepState,
        postActionState: postStepState,
      })
      if (strictResult.verified) {
        verifyResult = strictResult
      } else {
        // Permissive fallback: did the page change at all?
        const stateChanged =
          preStepState.url !== postStepState.url
          || preStepState.title !== postStepState.title
          || preStepState.snapshot !== postStepState.snapshot
        if (stateChanged) {
          verifyResult = { verified: true }
        } else {
          verifyResult = strictResult
        }
      }
    }
    turn.verified = verifyResult.verified
    if (!verifyResult.verified) {
      turn.verificationFailure = verifyResult.reason
    }
    turn.durationMs = Date.now() - stepStartedAt
    turns.push(turn)
    self.onTurn?.(turn)

    self.bus.emitNow({
      type: 'verify-completed',
      runId,
      turn: turnNumber,
      verified: verifyResult.verified,
      ...(verifyResult.reason ? { reason: verifyResult.reason } : {}),
      durationMs: Date.now() - verifyStartedAt,
    })
    self.bus.emitNow({
      type: 'plan-step-executed',
      runId,
      turn: turnNumber,
      stepIndex: stepIdx + 1,
      totalSteps: plan.steps.length,
      action: step.action,
      executeSuccess: true,
      verified: verifyResult.verified,
      durationMs: Date.now() - stepStartedAt,
      ...(verifyResult.reason ? { verifyReason: verifyResult.reason } : {}),
    })

    if (!verifyResult.verified) {
      self.bus.emitNow({
        type: 'plan-deviated',
        runId,
        turn: turnNumber,
        stepIndex: stepIdx + 1,
        totalSteps: plan.steps.length,
        reason: `verification failed at step ${stepIdx + 1}: ${verifyResult.reason ?? 'expected effect not observed'}`,
      })
      return {
        kind: 'deviated',
        lastState,
        failedStepIndex: stepIdx,
        reason: `verification failed at step ${stepIdx + 1}: ${verifyResult.reason ?? 'expected effect not observed'}`,
        turnsConsumed: stepIdx + 1,
      }
    }
  }

  // Auto-complete when the plan ends with meaningful runScript output.
  const lastStep = plan.steps[plan.steps.length - 1]
  if (
    lastStep
    && lastStep.action.action === 'runScript'
    && isMeaningfulRunScriptOutput(lastRunScriptOutput)
  ) {
    const synthTurnNumber = currentTurnIndex + 1
    const synthTurn: Turn = {
      turn: synthTurnNumber,
      state: lastState,
      action: { action: 'complete', result: lastRunScriptOutput! },
      reasoning: 'Auto-complete: plan ended after runScript, runner emitted complete with the runScript output',
      durationMs: 0,
    }
    turns.push(synthTurn)
    self.onTurn?.(synthTurn)
    self.bus.emitNow({
      type: 'plan-step-executed',
      runId,
      turn: synthTurnNumber,
      stepIndex: plan.steps.length + 1,
      totalSteps: plan.steps.length + 1,
      action: synthTurn.action,
      executeSuccess: true,
      verified: true,
      durationMs: 0,
    })
    if (self.config.debug) {
      console.log(`[Runner] Auto-emitted complete with runScript output (${lastRunScriptOutput!.length} chars) after plan exhausted`)
    }
    return {
      kind: 'completed',
      lastState,
      finalResult: lastRunScriptOutput!,
      turnsConsumed: plan.steps.length + 1,
    }
  }

  // If the plan produced extractWithIndex matches, fall through with the
  // match list so the LLM can choose the correct index.
  if (lastExtractOutput) {
    return {
      kind: 'deviated',
      lastState,
      failedStepIndex: plan.steps.length,
      reason: `plan completed extractWithIndex but the LLM must read the matches and pick by index. Match list:\n${lastExtractOutput.slice(0, 4000)}\n\nPick the index whose text matches the goal, then emit complete with result: <picked text>`,
      turnsConsumed: plan.steps.length,
    }
  }

  // If the plan ends with runScript but output is empty or placeholder-like,
  // fall through to per-action mode instead of completing with bad data.
  if (
    lastStep
    && lastStep.action.action === 'runScript'
    && !isMeaningfulRunScriptOutput(lastRunScriptOutput)
  ) {
    if (self.config.debug) {
      console.log(`[Runner] runScript returned no meaningful output (${JSON.stringify(lastRunScriptOutput).slice(0, 100)}); falling through to per-action loop for two-pass extraction`)
    }
    return {
      kind: 'deviated',
      lastState,
      failedStepIndex: plan.steps.length - 1,
      reason: `runScript returned no meaningful output (got: ${JSON.stringify(lastRunScriptOutput).slice(0, 200)}). The first-pass extraction failed — re-observe the page and try extractWithIndex with a wide query (e.g. 'p, span, dd, code') and a contains filter naming the expected text fragment. Pick-by-content beats pick-by-selector when the planner couldn't see the data at plan time.`,
      turnsConsumed: plan.steps.length,
    }
  }

  // All steps verified BUT the plan ended without an explicit complete/abort.
  // This means the planner emitted a finite sequence of "work" steps and
  // didn't terminate. The right behavior is NOT to fabricate a complete —
  // we treat plan exhaustion as a deviation that triggers fallback to the
  // per-action loop. The per-action loop will continue from the current
  // state and emit `complete` when the goal is genuinely met.
  return {
    kind: 'deviated',
    lastState,
    failedStepIndex: plan.steps.length,
    reason: 'plan exhausted without an explicit complete or abort step — falling through to per-action loop to finish the task',
    turnsConsumed: plan.steps.length,
  }
}
