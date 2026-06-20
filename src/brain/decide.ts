/**
 * The hot-loop decision methods for the Brain engine: the DOM-first `decide`
 * path, the vision-first / hybrid `decideVision` path, the navigation-model
 * routing classifier they share, and the tolerant JSON decision parser.
 *
 * Extracted from brain/index.ts via the delegate + host-interface pattern.
 * The Brain class keeps thin delegators (`decide`, `decideVision`, `parse`);
 * these free functions hold the method bodies verbatim and read/write Brain
 * state through {@link BrainDecideHost}, which Brain `implements` so tsc proves
 * the host surface is complete. Behavior is byte-identical to the inlined
 * versions — same ordering, thresholds, retries, and prompt text.
 */

import type { ModelMessage, SystemModelMessage } from 'ai';
import type { PageState } from '../types.js';
import { parseNextActions, validateAction } from './action-parse.js';
import { budgetSnapshot, compactFirstTurnSnapshot } from './snapshot-budget.js';
import {
  VISION_FIRST_PROMPT,
  UNIFIED_VISION_DOM_PROMPT,
  FIRST_TURN_COMPACT_PROMPT,
} from './prompts.js';
import { compactHistory } from './history-compact.js';
import type { BrainDecision, UserContent } from './types.js';
import type { BrainProvider, ModelSelection, GenerateResult } from './model-client.js';

/**
 * The slice of Brain state the decision hot loop reads/writes. Brain declares
 * `implements BrainDecideHost`, so a missing or mistyped member is a compile
 * error — this interface IS the safety gate for the extraction. All members
 * are public on Brain by construction.
 */
export interface BrainDecideHost {
  provider: BrainProvider;
  modelName: string;
  navProvider?: BrainProvider;
  navModelName?: string;
  adaptiveModelRouting: boolean;
  observationMode: 'dom' | 'vision' | 'hybrid';
  visionStrategy: 'always' | 'never' | 'auto';
  compactFirstTurn: boolean;
  lastDecisionUrl?: string;
  history: ModelMessage[];
  maxHistoryTurns: number;
  debug: boolean;
  baseUrl?: string;
  buildUserContent(text: string, screenshot?: string, forceVision?: boolean): UserContent;
  buildSystemForDecide(
    goal: string,
    state: PageState,
    turn: number,
    providerName: BrainProvider,
  ): string | SystemModelMessage[];
  generate(
    system: string | SystemModelMessage[],
    messages: ModelMessage[],
    selection?: ModelSelection,
    maxOutputTokens?: number,
  ): Promise<GenerateResult>;
}

/**
 * Classify whether this turn should use the nav (cheap) model for decide().
 *
 * Empirically tested: routing early navigation turns to gpt-4.1-mini causes
 * worse decisions that cascade into longer runs (more turns = more total cost).
 * gpt-5.4 without routing is cheaper overall because it navigates more efficiently.
 *
 * Current strategy: nav model is ONLY used for verification (see verifyGoalCompletion),
 * not for decide(). The flag is kept for future experiments with better routing signals.
 */
function shouldUseNavigationModel(
  self: BrainDecideHost,
  state: PageState,
  extraContext?: string,
  turnInfo?: { current: number; max: number },
): boolean {
  if (!self.adaptiveModelRouting || !self.navModelName) return false;
  // Use the navigation model for DOM-only same-page turns. Keep the primary
  // model for first turns, new pages, and error recovery.
  const isFirstTurn = !turnInfo || turnInfo.current <= 1;
  const samePageAsPrevious = self.lastDecisionUrl === state.url;
  const hasError = extraContext?.includes('REJECTED') || extraContext?.includes('ERROR');
  if (isFirstTurn || !samePageAsPrevious || hasError) return false;
  return true;
}

export async function decideImpl(
  self: BrainDecideHost,
  goal: string,
  state: PageState,
  extraContext?: string,
  turnInfo?: { current: number; max: number },
  options?: { forceVision?: boolean }
): Promise<BrainDecision> {
  // Vision-first and hybrid modes delegate to the vision path.
  if (self.observationMode === 'vision' || self.observationMode === 'hybrid') {
    return decideVisionImpl(self, goal, state, extraContext, turnInfo);
  }

  const useCompactFirstTurn = self.compactFirstTurn && turnInfo?.current === 1;
  const samePageAsPrevious = self.lastDecisionUrl === state.url;
  const isFirstTurn = !turnInfo || turnInfo.current <= 1;

  // Diff-only mode: on same-page turns with small diffs, send only changed
  // elements instead of the full snapshot. Saves 40-80% of input tokens on
  // form-fill / interaction-heavy pages where the page structure is stable.
  const rawDiff = state.snapshotDiffRaw;
  const diffChanges = rawDiff ? rawDiff.added.length + rawDiff.removed.length + rawDiff.changed.length : 0;
  const diffTotal = rawDiff ? diffChanges + rawDiff.unchangedCount : 0;
  const useDiffOnly = samePageAsPrevious
    && !isFirstTurn
    && rawDiff !== undefined
    && diffChanges > 0
    && diffTotal > 0
    && diffChanges / diffTotal < 0.3;

  // Tighter snapshot budget on same-page turns; new pages keep enough
  // content for extraction from docs/spec pages.
  const snapshotBudget = samePageAsPrevious ? 8_000 : 24_000;
  let visibleSnapshot: string;
  let elementsHeader: string;
  if (useDiffOnly) {
    // Build compact diff-only view: changed/added elements with refs
    const lines: string[] = [];
    if (rawDiff!.added.length) lines.push('ADDED:', ...rawDiff!.added);
    if (rawDiff!.changed.length) lines.push('CHANGED:', ...rawDiff!.changed);
    if (rawDiff!.removed.length) lines.push('REMOVED:', ...rawDiff!.removed);
    lines.push(`(${rawDiff!.unchangedCount} elements unchanged — refs from previous turn still valid)`);
    visibleSnapshot = lines.join('\n');
    elementsHeader = 'ELEMENTS (diff-only, previous refs still valid)';
  } else {
    visibleSnapshot = useCompactFirstTurn
      ? compactFirstTurnSnapshot(state.snapshot)
      : budgetSnapshot(state.snapshot, snapshotBudget);
    elementsHeader = 'ELEMENTS';
  }
  self.lastDecisionUrl = state.url;

  // Build user message with stable prefix (GOAL) for prompt caching,
  // then dynamic per-turn content (turn budget, page state, elements).
  let textContent = `GOAL: ${goal}

CURRENT PAGE:
URL: ${state.url}
Title: ${state.title}

${elementsHeader}:
${visibleSnapshot}`;

  if (turnInfo) {
    const remaining = turnInfo.max - turnInfo.current;
    const budgetUsed = turnInfo.current / turnInfo.max;
    textContent += `\n\nTURN: ${turnInfo.current}/${turnInfo.max} (${remaining} remaining)`;
    if (remaining === 1) {
      textContent += ` — FINAL TURN: return a terminal action only (complete or abort)`;
    } else if (remaining <= 3) {
      textContent += ` — RUNNING LOW, avoid exploratory navigation; prioritize completing the goal or aborting with a clear blocker reason`;
    } else if (budgetUsed >= 0.5) {
      textContent += ` — HALF BUDGET USED. If you have extracted useful data, try completing now. Do not navigate away from pages with relevant content without attempting completion first`;
    }
  }

  // Append snapshot diff only when NOT using diff-only mode (avoid redundant info)
  if (!useDiffOnly && state.snapshotDiff && state.snapshotDiff.length < state.snapshot.length * 0.3) {
    textContent += `\n\nSNAPSHOT CHANGES (since last turn):\n${state.snapshotDiff}`;
  }

  if (extraContext) {
    textContent += `\n\n${extraContext}`;
  }

  textContent += '\n\nWhat action should you take?';

  const userContent = self.buildUserContent(textContent, state.screenshot, options?.forceVision === true);
  const useNavModel = shouldUseNavigationModel(self, state, extraContext, turnInfo);
  const effectiveProvider = useNavModel ? (self.navProvider || self.provider) : self.provider;
  const effectiveModel = useNavModel ? (self.navModelName || self.modelName) : self.modelName;

  if (self.debug) {
    const turnNum = Math.floor(self.history.length / 2) + 1;
    const usingVision = !!state.screenshot && (
      self.visionStrategy === 'always' || (self.visionStrategy === 'auto' && options?.forceVision === true)
    );
    console.log(`[Brain] Turn ${turnNum} | URL: ${state.url} | Vision: ${usingVision}`);
    if (self.adaptiveModelRouting) {
      const mode = useNavModel ? 'nav-model' : 'primary-model';
      console.log(`[Brain] Model route: ${mode} (${effectiveProvider}/${effectiveModel}) turn=${turnInfo?.current}/${turnInfo?.max}`);
    }
  }

  const messages: ModelMessage[] = [
    ...compactHistory(self.history),
    { role: 'user', content: userContent },
  ];

  const dynamicSystemPrompt: string | SystemModelMessage[] = useCompactFirstTurn
    ? FIRST_TURN_COMPACT_PROMPT
    : self.buildSystemForDecide(goal, state, turnInfo?.current ?? 1, effectiveProvider)

  const modelOpts = { provider: effectiveProvider, model: effectiveModel };
  // Bump output budget near max turns so data-heavy completions don't truncate
  const nearingEnd = turnInfo && turnInfo.current >= turnInfo.max - 3;
  const maxTokens = useCompactFirstTurn ? 500 : nearingEnd ? 1200 : 600;
  const result = await self.generate(dynamicSystemPrompt, messages, modelOpts, maxTokens);

  let raw = result.text;
  let tokensUsed = result.tokensUsed;
  let inputTokens = result.inputTokens;
  let outputTokens = result.outputTokens;
  let cacheReadInputTokens = result.cacheReadInputTokens;
  let cacheCreationInputTokens = result.cacheCreationInputTokens;

  if (!raw) {
    throw new Error('Brain.decide: LLM returned empty response — possible rate limit or model error');
  }

  if (self.debug) {
    console.log('[Brain] Response:', raw.slice(0, 300));
  }

  let parsed = parseDecision(raw);

  // On malformed JSON, retry with minimal context (current page + correction
  // hint) instead of burning a full turn. Costs ~7K tokens vs ~25K for a
  // full-history retry on the next turn.
  if (parsed.reasoning?.startsWith('Malformed LLM JSON response') && !useCompactFirstTurn) {
    if (self.debug) {
      console.log('[Brain] Malformed JSON — retrying with format hint');
    }
    const retryMessages: ModelMessage[] = [
      { role: 'user', content: userContent },
      { role: 'assistant', content: raw },
      { role: 'user', content: 'Your previous response was not valid JSON. Respond with ONLY a valid JSON object matching the required schema.' },
    ];
    try {
      const retryResult = await self.generate(dynamicSystemPrompt, retryMessages, modelOpts, maxTokens);
      if (retryResult.text) {
        const retryParsed = parseDecision(retryResult.text);
        if (!retryParsed.reasoning?.startsWith('Malformed LLM JSON response')) {
          raw = retryResult.text;
          parsed = retryParsed;
        } else if (self.baseUrl) {
          // Both the initial parse and the format-hint retry failed while a
          // custom LLM_BASE_URL is set. Strong signal the gateway is
          // returning a shape the scout can't consume (e.g. SSE streams,
          // non-JSON wrappers). Surface the likely cause instead of
          // burning silent retries turn after turn.
          console.error(
            `[Brain] scout_json_parse_failed: LLM_BASE_URL=${self.baseUrl} returned a response the scout could not parse even after a format-hint retry. ` +
            `Suggestion: switch to an Anthropic-native endpoint, or verify the gateway supports non-streaming chat/completions with { "response_format": { "type": "json_object" } }.`
          );
        }
        tokensUsed = (tokensUsed ?? 0) + (retryResult.tokensUsed ?? 0);
        inputTokens = (inputTokens ?? 0) + (retryResult.inputTokens ?? 0);
        outputTokens = (outputTokens ?? 0) + (retryResult.outputTokens ?? 0);
        if (retryResult.cacheReadInputTokens !== undefined) {
          cacheReadInputTokens = (cacheReadInputTokens ?? 0) + retryResult.cacheReadInputTokens;
        }
        if (retryResult.cacheCreationInputTokens !== undefined) {
          cacheCreationInputTokens = (cacheCreationInputTokens ?? 0) + retryResult.cacheCreationInputTokens;
        }
      }
    } catch {
      // Retry failed — fall through with original wait(1000) fallback
    }
  }

  // Store in history
  self.history.push({ role: 'user', content: userContent });
  self.history.push({ role: 'assistant', content: raw });

  // Trim old history
  const maxMessages = self.maxHistoryTurns * 2;
  if (self.history.length > maxMessages) {
    self.history = self.history.slice(-maxMessages);
  }

  return {
    ...parsed,
    raw,
    tokensUsed,
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    modelUsed: effectiveModel,
  };
}

/**
 * Vision-first decision path. The screenshot is the primary
 * observation; DOM snapshot is minimal context (URL, title only in pure
 * vision mode, or compact DOM in hybrid mode). The LLM outputs
 * coordinate-based actions (clickAt, typeAt) in 1024×768 virtual space.
 */
export async function decideVisionImpl(
  self: BrainDecideHost,
  goal: string,
  state: PageState,
  extraContext?: string,
  turnInfo?: { current: number; max: number },
): Promise<BrainDecision> {
  self.lastDecisionUrl = state.url;

  // Adaptive observation: on same-page hybrid turns, send only changed
  // elements when the diff is small.
  const isHybrid = self.observationMode === 'hybrid';
  const samePageAsPrevious = self.lastDecisionUrl === state.url;
  const isFirstTurn = !turnInfo || turnInfo.current <= 1;
  const rawDiff = state.snapshotDiffRaw;
  const diffChanges = rawDiff ? rawDiff.added.length + rawDiff.removed.length + rawDiff.changed.length : 0;
  const diffTotal = rawDiff ? diffChanges + rawDiff.unchangedCount : 0;
  const useDiffOnly = isHybrid && samePageAsPrevious && !isFirstTurn
    && rawDiff !== undefined && diffChanges > 0 && diffTotal > 0
    && diffChanges / diffTotal < 0.4;

  let textContent = `GOAL: ${goal}

CURRENT PAGE:
URL: ${state.url}
Title: ${state.title}`;

  if (isHybrid && state.snapshot) {
    if (useDiffOnly) {
      // Diff-focused: only what changed since last turn
      const lines: string[] = [];
      if (rawDiff!.added.length) lines.push('ADDED:', ...rawDiff!.added);
      if (rawDiff!.changed.length) lines.push('CHANGED:', ...rawDiff!.changed);
      if (rawDiff!.removed.length) lines.push('REMOVED:', ...rawDiff!.removed);
      lines.push(`(${rawDiff!.unchangedCount} elements unchanged — refs from previous turn still valid)`);
      textContent += `\n\nPAGE CHANGES (what changed after your last action — this is the important part):\n${lines.join('\n')}`;
    } else {
      // Progressive budget reduction: more turns on same page = less snapshot
      // needed (agent has already seen the full page, rely on screenshot + diff).
      const sameTurnCount = samePageAsPrevious ? (turnInfo?.current || 0) : 0;
      const snapshotBudget = samePageAsPrevious
        ? (sameTurnCount >= 8 ? 2_500 : 4_000)  // aggressive after 8+ same-page turns
        : 6_000;
      const snap = budgetSnapshot(state.snapshot, snapshotBudget);
      textContent += `\n\nELEMENTS:\n${snap}`;
    }
  }

  if (turnInfo) {
    const remaining = turnInfo.max - turnInfo.current;
    textContent += `\n\nTURN: ${turnInfo.current}/${turnInfo.max} (${remaining} remaining)`;
    if (remaining === 1) {
      textContent += ` — FINAL TURN: return a terminal action only (complete or abort)`;
    } else if (remaining <= 3) {
      textContent += ` — RUNNING LOW, prioritize completing the goal or aborting`;
    }
  }

  if (extraContext) {
    textContent += `\n\n${extraContext}`;
  }

  textContent += '\n\nLook at the screenshot. What action should you take?';

  // Screenshot is required for vision-first mode
  if (!state.screenshot) {
    return {
      action: { action: 'wait', ms: 500 },
      reasoning: 'No screenshot available for vision-first mode — waiting for page to render',
      raw: '{"action":{"action":"wait","ms":500}}',
    };
  }

  const userContent: UserContent = [
    { type: 'text' as const, text: textContent },
    { type: 'image' as const, image: state.screenshot, mediaType: 'image/jpeg' },
  ];

  // Strip old screenshots from history; the current screenshot is the only
  // image the model needs for this turn.
  const compacted = compactHistory(self.history).map((msg) => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg;
    const textOnly = (msg.content as Array<{ type: string }>)
      .filter((part) => part.type === 'text');
    if (textOnly.length === msg.content.length) return msg;
    return { ...msg, content: textOnly } as ModelMessage;
  });

  const messages: ModelMessage[] = [
    ...compacted,
    { role: 'user', content: userContent },
  ];

  // Vision turns stay on the main model because smaller model routes can
  // count image tokens differently and exhaust the token budget.
  const modelOpts = { provider: self.provider, model: self.modelName };
  const nearingEnd = turnInfo && turnInfo.current >= turnInfo.max - 3;
  const maxTokens = nearingEnd ? 1200 : 600;
  // Hybrid mode uses the unified prompt with both action vocabularies.
  const systemPrompt = isHybrid ? UNIFIED_VISION_DOM_PROMPT : VISION_FIRST_PROMPT;
  const result = await self.generate(systemPrompt, messages, modelOpts, maxTokens);

  const raw = result.text;
  if (!raw) {
    throw new Error('Brain.decideVision: LLM returned empty response');
  }

  if (self.debug) {
    console.log('[Brain/Vision] Response:', raw.slice(0, 300));
  }

  const parsed = parseDecision(raw);

  self.history.push({ role: 'user', content: userContent });
  self.history.push({ role: 'assistant', content: raw });

  const maxMessages = self.maxHistoryTurns * 2;
  if (self.history.length > maxMessages) {
    self.history = self.history.slice(-maxMessages);
  }

  return {
    ...parsed,
    raw,
    tokensUsed: result.tokensUsed,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheReadInputTokens: result.cacheReadInputTokens,
    cacheCreationInputTokens: result.cacheCreationInputTokens,
    modelUsed: self.modelName,
  };
}

export function parseDecision(raw: string): Omit<BrainDecision, 'raw' | 'tokensUsed'> {
  let text = raw.trim();

  // Strip markdown code blocks
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  const VALID_ACTIONS = new Set([
    'click', 'type', 'press', 'hover', 'select',
    'scroll', 'navigate', 'wait', 'evaluate', 'runScript',
    'extractWithIndex',
    'verifyPreview', 'complete', 'abort',
    'fill', 'clickSequence',
    'clickAt', 'typeAt',
    'clickLabel', 'typeLabel',
    // Macro dispatch. The driver validates the macro name at execute time.
    'macro',
    // Parallel fan-out. Runner handles dispatch; validator checks shape.
    'fanOut',
  ]);

  // Parse strategy: exact → first-{/last-} extraction.
  // Some OpenAI-compat gateways (router.tangle.tools, LiteLLM proxies, etc.)
  // wrap model output in prose preambles ("Here's your response:\n{...}")
  // that markdown-fence stripping doesn't catch. Fall back to extracting the
  // outermost object literal before giving up.
  let parsed: Record<string, unknown> | null = null;
  let parseError = '';
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        parsed = JSON.parse(text.slice(firstBrace, lastBrace + 1));
        parseError = '';
      } catch { /* fall through to retry fallback */ }
    }
  }

  if (!parsed) {
    return {
      // Do not hard-abort the scenario on transient JSON formatting issues.
      // Waiting one turn lets the loop continue and recover on the next model call.
      action: { action: 'wait', ms: 1000 },
      reasoning: `Malformed LLM JSON response (${parseError}). Retrying next turn.`,
    };
  }

  try {
    const actionObj = parsed.action && typeof parsed.action === 'object' ? parsed.action as Record<string, unknown> : parsed;
    const actionType = typeof parsed.action === 'string' ? parsed.action : (actionObj as { action?: string })?.action;

    if (!actionType) {
      throw new Error('Missing action field');
    }

    if (!VALID_ACTIONS.has(actionType)) {
      throw new Error(`Unknown action "${actionType}". Valid: ${[...VALID_ACTIONS].join(', ')}`);
    }

    const actionData: Record<string, unknown> = parsed.action && typeof parsed.action === 'object'
      ? parsed.action as Record<string, unknown>
      : parsed;
    const action = validateAction(actionType, actionData);

    return {
      action,
      nextActions: parseNextActions(parsed, VALID_ACTIONS),
      reasoning: (parsed.reasoning || parsed.thought || parsed.thinking) as string | undefined,
      plan: Array.isArray(parsed.plan) ? parsed.plan as string[] : undefined,
      currentStep: typeof parsed.currentStep === 'number' ? parsed.currentStep : undefined,
      expectedEffect: (parsed.expectedEffect || parsed.expected_effect) as string | undefined,
    };
  } catch (err) {
    const validationError = err instanceof Error ? err.message : String(err);
    return {
      action: { action: 'wait', ms: 1000 },
      reasoning: `Malformed LLM JSON response (${validationError}). Retrying next turn.`,
    };
  }
}
