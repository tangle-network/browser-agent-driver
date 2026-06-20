/**
 * Whole-task planning for the Brain engine: a single LLM call that returns a
 * structured, deterministically-executable Plan (or null when the response is
 * unusable, signalling the runner to fall back to the per-action loop).
 *
 * Extracted from brain/index.ts via the delegate + host-interface pattern.
 * The Brain class keeps a thin `plan` delegator; this free function holds the
 * method body verbatim and reads Brain state through {@link BrainPlanHost},
 * which Brain `implements` so tsc proves the host surface is complete.
 * Behavior is byte-identical — same JSON tolerance, step validation, and
 * fallback shapes.
 */

import type { ModelMessage, SystemModelMessage } from 'ai';
import type { Action, PageState, Plan, PlanStep } from '../types.js';
import { validateAction } from './action-parse.js';
import { budgetSnapshot } from './snapshot-budget.js';
import { buildPlanSystemPrompt } from './prompts.js';
import type { UserContent } from './types.js';
import type { BrainProvider, ModelSelection, GenerateResult } from './model-client.js';

/**
 * The slice of Brain state the planner reads. Brain declares
 * `implements BrainPlanHost`, so a missing or mistyped member is a compile
 * error — this interface IS the safety gate for the extraction. All members
 * are public on Brain by construction.
 */
export interface BrainPlanHost {
  provider: BrainProvider;
  modelName: string;
  plannerModel?: string;
  plannerProvider?: string;
  observationMode: 'dom' | 'vision' | 'hybrid';
  generate(
    system: string | SystemModelMessage[],
    messages: ModelMessage[],
    selection?: ModelSelection,
    maxOutputTokens?: number,
  ): Promise<GenerateResult>;
}

/**
 * Generate a structured plan for the entire task with one LLM call.
 *
 * The runner executes the plan deterministically (no LLM between steps),
 * falling back to per-action `decide()` only when verification fails.
 * Returns null when:
 *   - the LLM response is unparseable JSON (fall through to per-action)
 *   - the plan has zero steps
 *   - any plan step has an invalid/unknown action shape
 *
 * The caller (BrowserAgent.run) treats null as "planner unavailable,
 * use per-action loop".
 */
export async function planImpl(
  self: BrainPlanHost,
  goal: string,
  state: PageState,
  options?: { maxSteps?: number; extraContext?: string },
): Promise<{
  plan: Plan | null
  raw: string
  durationMs: number
  tokensUsed?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  parseError?: string
}> {
  const startedAt = Date.now()
  const maxSteps = options?.maxSteps ?? 12
  const extraContext = options?.extraContext

  // Planner snapshots keep enough context for extraction tasks, especially
  // docs/spec pages with data in `<dl>`, `<code>`, and `<pre>` blocks.
  const snapshot = budgetSnapshot(state.snapshot, 24_000)

  const planSystemPrompt = buildPlanSystemPrompt(maxSteps)

  // Replan path: when the runner re-enters plan() after a previous plan
  // deviated, it injects a deviation summary. The system prompt is byte-
  // stable so prompt cache still hits — only the user message changes.
  const userText = `GOAL: ${goal}

CURRENT PAGE:
URL: ${state.url}
Title: ${state.title}

ELEMENTS:
${snapshot}
${extraContext ? `\n${extraContext}\n` : ''}
What is the complete plan?`

  // In vision-capable modes, include the screenshot so the planner can use
  // visual layout when the DOM does not capture form structure.
  const isVisionPlanner = (self.observationMode === 'hybrid' || self.observationMode === 'vision') && !!state.screenshot;
  const userContent: UserContent = isVisionPlanner
    ? [
        { type: 'text' as const, text: userText },
        { type: 'image' as const, image: state.screenshot!, mediaType: 'image/jpeg' },
      ]
    : userText;

  // Planner can use its own model override.
  const planModelOpts = self.plannerModel
    ? { provider: (self.plannerProvider || self.provider) as typeof self.provider, model: self.plannerModel }
    : { provider: self.provider, model: self.modelName };
  const result = await self.generate(
    planSystemPrompt,
    [{ role: 'user', content: userContent }],
    planModelOpts,
    // Plans need more output tokens than decide() — a 10-step plan with
    // batch fills + rationale per step is comfortably over 1000 tokens.
    2_500,
  ).catch((err) => ({
    text: '',
    tokensUsed: undefined,
    inputTokens: undefined,
    outputTokens: undefined,
    cacheReadInputTokens: undefined,
    cacheCreationInputTokens: undefined,
    _error: err instanceof Error ? err.message : String(err),
  }))

  const durationMs = Date.now() - startedAt
  const raw = (result as { text: string }).text

  if (!raw) {
    return {
      plan: null,
      raw: '',
      durationMs,
      parseError: (result as { _error?: string })._error ?? 'empty response',
    }
  }

  // Reuse the same JSON tolerance as decide(): strip markdown fences,
  // then JSON.parse. On parse failure, return null and let the runner
  // fall through.
  let body = raw.trim()
  if (body.startsWith('```')) {
    body = body.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  }

  let parsed: { reasoning?: string; finalResult?: string; steps?: unknown[] }
  try {
    parsed = JSON.parse(body) as { reasoning?: string; finalResult?: string; steps?: unknown[] }
  } catch (err) {
    return {
      plan: null,
      raw,
      durationMs,
      tokensUsed: result.tokensUsed,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheReadInputTokens: result.cacheReadInputTokens,
      cacheCreationInputTokens: result.cacheCreationInputTokens,
      parseError: err instanceof Error ? err.message : String(err),
    }
  }

  if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    return {
      plan: null,
      raw,
      durationMs,
      tokensUsed: result.tokensUsed,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheReadInputTokens: result.cacheReadInputTokens,
      cacheCreationInputTokens: result.cacheCreationInputTokens,
      parseError: 'plan has zero steps',
    }
  }

  // Validate each step. Each must have a parseable action and a non-empty
  // expectedEffect string. We use the same validateAction helper that the
  // per-action parser uses, so the action shapes stay consistent.
  const steps: PlanStep[] = []
  for (const [idx, rawStep] of parsed.steps.entries()) {
    if (!rawStep || typeof rawStep !== 'object') {
      return {
        plan: null,
        raw,
        durationMs,
        tokensUsed: result.tokensUsed,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadInputTokens: result.cacheReadInputTokens,
        cacheCreationInputTokens: result.cacheCreationInputTokens,
        parseError: `step ${idx + 1}: not an object`,
      }
    }
    const stepObj = rawStep as Record<string, unknown>
    const actionRaw = stepObj.action
    if (!actionRaw || typeof actionRaw !== 'object') {
      return {
        plan: null,
        raw,
        durationMs,
        parseError: `step ${idx + 1}: missing action`,
      }
    }
    const actionData = actionRaw as Record<string, unknown>
    const actionType = actionData.action
    if (typeof actionType !== 'string') {
      return {
        plan: null,
        raw,
        durationMs,
        parseError: `step ${idx + 1}: action.action must be a string`,
      }
    }
    let action: Action
    try {
      action = validateAction(actionType, actionData)
    } catch (err) {
      return {
        plan: null,
        raw,
        durationMs,
        parseError: `step ${idx + 1}: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
    const expectedEffect = typeof stepObj.expectedEffect === 'string' && stepObj.expectedEffect.length > 0
      ? stepObj.expectedEffect
      : 'page state advances after this action'
    const rationale = typeof stepObj.rationale === 'string' ? stepObj.rationale : undefined
    steps.push({ action, expectedEffect, ...(rationale ? { rationale } : {}) })
  }

  const plan: Plan = {
    steps: steps.slice(0, maxSteps),
    ...(typeof parsed.finalResult === 'string' ? { finalResult: parsed.finalResult } : {}),
    ...(typeof parsed.reasoning === 'string' ? { reasoning: parsed.reasoning } : {}),
  }

  return {
    plan,
    raw,
    durationMs,
    tokensUsed: result.tokensUsed,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheReadInputTokens: result.cacheReadInputTokens,
    cacheCreationInputTokens: result.cacheCreationInputTokens,
  }
}
