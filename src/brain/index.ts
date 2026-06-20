/**
 * LLM Decision Engine — multimodal (vision + text), planning, verification,
 * conversation history management, and quality evaluation.
 *
 * Uses Vercel AI SDK for multi-provider support (OpenAI, Anthropic, Google, Codex CLI, Claude Code).
 */

import { generateText } from 'ai';
import type { ModelMessage, LanguageModel, SystemModelMessage } from 'ai';
import type { PageState, AgentConfig, DesignFinding, GoalVerification, Plan } from '../types.js';
import { SYSTEM_PROMPT } from './prompts.js';

import type { BrainDecision, QualityEvaluation, LinkScoutRecommendation, UserContent } from './types.js';
import { decideImpl, decideVisionImpl, parseDecision } from './decide.js';
import type { BrainDecideHost } from './decide.js';
import { planImpl } from './plan.js';
import type { BrainPlanHost } from './plan.js';
import {
  getModelImpl,
  getLanguageModelImpl,
  generateImpl,
  generationOptionsImpl,
  completeImpl,
  completeVisionImpl,
} from './model-client.js';
import type { BrainModelHost, ModelSelection, GenerateResult } from './model-client.js';
import {
  composeSystemPromptPartsImpl,
  buildSystemForDecideImpl,
} from './system-prompt.js';
import type { BrainSystemPromptHost } from './system-prompt.js';
import { evaluateImpl } from './tasks/evaluate.js';
import type { BrainEvaluateHost } from './tasks/evaluate.js';
import { recommendLinkCandidateImpl } from './tasks/link-scout.js';
import type { BrainLinkScoutHost } from './tasks/link-scout.js';
import { verifyGoalCompletionImpl } from './tasks/goal-verification.js';
import type { BrainGoalVerificationHost } from './tasks/goal-verification.js';
import { auditDesignImpl } from './tasks/design-audit.js';
import type { BrainDesignAuditHost } from './tasks/design-audit.js';
import { extractKnowledgeImpl } from './tasks/knowledge.js';
import type { BrainKnowledgeHost } from './tasks/knowledge.js';

export { budgetSnapshot } from './snapshot-budget.js';
export type { BrainDecision, QualityEvaluation, LinkScoutRecommendation } from './types.js';

export class Brain implements BrainModelHost, BrainSystemPromptHost, BrainEvaluateHost, BrainLinkScoutHost, BrainGoalVerificationHost, BrainDesignAuditHost, BrainKnowledgeHost, BrainDecideHost, BrainPlanHost {
  // Public fields below satisfy the extracted host interfaces (BrainModelHost,
  // BrainSystemPromptHost). The free functions in model-client.ts and
  // system-prompt.ts read them through those interfaces; `implements` makes
  // tsc prove the surface is complete.
  modelCache = new Map<string, LanguageModel>();
  provider: 'openai' | 'anthropic' | 'google' | 'cli-bridge' | 'codex-cli' | 'claude-code' | 'sandbox-backend' | 'zai-coding-plan';
  modelName: string;
  // Public fields below additionally satisfy the extracted task host interfaces
  // (BrainLinkScoutHost, BrainGoalVerificationHost).
  adaptiveModelRouting: boolean;
  navModelName?: string;
  navProvider?: 'openai' | 'anthropic' | 'google' | 'cli-bridge' | 'codex-cli' | 'claude-code' | 'sandbox-backend' | 'zai-coding-plan';
  explicitApiKey?: string;
  baseUrl?: string;
  debug: boolean;
  history: ModelMessage[] = [];
  maxHistoryTurns: number;
  private visionEnabled: boolean;
  visionStrategy: 'always' | 'never' | 'auto';
  observationMode: 'dom' | 'vision' | 'hybrid';
  // Force streaming input on claude-code so completeVision images are not dropped
  // (the Claude Code SDK omits image parts without it). Off by default; set only
  // by the vision-judge wiring. See AgentConfig.claudeCodeStreamingInput.
  claudeCodeStreamingInput: boolean;
  llmTimeoutMs: number;
  compactFirstTurn: boolean;
  lastDecisionUrl?: string;
  systemPrompt: string;
  scoutModelName?: string;
  scoutProvider?: 'openai' | 'anthropic' | 'google' | 'cli-bridge' | 'codex-cli' | 'claude-code' | 'sandbox-backend' | 'zai-coding-plan';
  scoutUseVision: boolean;
  // Per-role model overrides.
  plannerModel?: string;
  plannerProvider?: string;
  verifierModel?: string;
  verifierProvider?: string;
  private supervisorModel?: string;
  private supervisorProvider?: string;
  sandboxBackendType?: string;
  sandboxBackendProfile?: string;
  sandboxBackendProvider?: string;
  // Extension-supplied rules. Set via setExtensionRules() — null/undefined
  // when no extensions are loaded (default).
  extensionRules?: { global?: string; search?: string; dataExtraction?: string; heavy?: string };
  extensionDomainRules?: Record<string, { extraRules?: string }>;
  /** Rendered macro prompt block; set via setMacroPromptBlock(). Empty string when no macros loaded. */
  macroPromptBlock = '';

  constructor(config: AgentConfig = {}) {
    this.llmTimeoutMs = config.llmTimeoutMs ?? 60_000;
    this.provider = config.provider || 'openai';
    this.modelName = config.model || 'gpt-5.4';
    this.adaptiveModelRouting = config.adaptiveModelRouting === true;
    // Default nav model to gpt-4.1-mini when adaptive routing is on (9x cheaper output than gpt-5.4)
    this.navModelName = config.navModel || (this.adaptiveModelRouting ? 'gpt-4.1-mini' : undefined);
    this.navProvider = config.navProvider;
    this.explicitApiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
    this.systemPrompt = config.systemPrompt || SYSTEM_PROMPT;
    this.debug = config.debug || false;
    this.maxHistoryTurns = config.maxHistoryTurns || 10;
    this.visionEnabled = config.vision !== false;
    this.visionStrategy = config.visionStrategy ?? (this.visionEnabled ? 'always' : 'never');
    this.observationMode = config.observationMode ?? 'dom';
    this.claudeCodeStreamingInput = config.claudeCodeStreamingInput === true;
    this.compactFirstTurn = config.compactFirstTurn === true;
    this.sandboxBackendType = config.sandboxBackendType;
    this.sandboxBackendProfile = config.sandboxBackendProfile;
    this.sandboxBackendProvider = config.sandboxBackendProvider;
    this.scoutModelName = config.scout?.model;
    this.scoutProvider = config.scout?.provider;
    this.scoutUseVision = config.scout?.useVision === true;
    // Per-role model overrides.
    this.plannerModel = config.models?.planner?.model;
    this.plannerProvider = config.models?.planner?.provider;
    this.verifierModel = config.models?.verifier?.model;
    this.verifierProvider = config.models?.verifier?.provider;
    this.supervisorModel = config.models?.supervisor?.model;
    this.supervisorProvider = config.models?.supervisor?.provider;
    // executor uses navModel (already wired) — config.models.executor overrides it
    if (config.models?.executor) {
      this.navModelName = config.models.executor.model;
      this.navProvider = (config.models.executor.provider as typeof this.navProvider) || this.navProvider;
      this.adaptiveModelRouting = true; // enable routing when executor model is set
    }
  }

  private generationOptions(
    maxOutputTokens: number,
    selection?: ModelSelection,
  ): Record<string, unknown> {
    return generationOptionsImpl(this, maxOutputTokens, selection);
  }

  /** Get a LLM model instance, optionally with provider/model override (e.g. for CAPTCHA fallback) */
  async getLanguageModel(selection?: { provider?: 'openai' | 'anthropic' | 'google' | 'cli-bridge'; model?: string }): Promise<LanguageModel> {
    return getLanguageModelImpl(this, selection)
  }

  /** Lazily create the LLM model instance based on provider config */
  private getModel(selection?: ModelSelection): Promise<LanguageModel> {
    return getModelImpl(this, selection);
  }

  // Public so the extracted task impls (src/brain/tasks/*) can reach it through
  // their host interfaces. The class still owns the single transport funnel.
  generate(
    system: string | SystemModelMessage[],
    messages: ModelMessage[],
    selection?: ModelSelection,
    maxOutputTokens = 800,
  ): Promise<GenerateResult> {
    return generateImpl(this, system, messages, selection, maxOutputTokens);
  }

  /**
   * Inject extension-supplied rules. Called by the runner after loading
   * `bad.config.{js,mjs,ts}`. Pass undefined to clear.
   */
  setExtensionRules(
    sectionRules?: { global?: string; search?: string; dataExtraction?: string; heavy?: string },
    domainRules?: Record<string, { extraRules?: string }>,
  ): void {
    this.extensionRules = sectionRules
    this.extensionDomainRules = domainRules
  }

  /** Inject the rendered macro catalog (from macro-loader.renderMacroPromptBlock)
   *  so the agent knows which macros exist. Pass empty string to clear. */
  setMacroPromptBlock(block: string): void {
    this.macroPromptBlock = block ?? ''
  }

  private composeSystemPromptParts(goal: string, state: PageState, turn: number): string[] {
    return composeSystemPromptPartsImpl(this, goal, state, turn)
  }

  /**
   * Build the system prompt for `decide()` in the form best suited to the
   * active provider:
   *   - Anthropic: a SystemModelMessage[] with `cache_control: ephemeral`
   *     on the CORE_RULES slot. Subsequent turns get a cache hit on the
   *     ~1500-token prefix (90% cheaper input + faster TTFT).
   *   - Everything else: a single concatenated string (current behavior).
   *
   * Custom system prompts (set via config) are passed verbatim — caching
   * is opt-in via the default prompt path only.
   */
  buildSystemForDecide(
    goal: string,
    state: PageState,
    turn: number,
    providerName: 'openai' | 'anthropic' | 'google' | 'cli-bridge' | 'codex-cli' | 'claude-code' | 'sandbox-backend' | 'zai-coding-plan',
  ): string | SystemModelMessage[] {
    return buildSystemForDecideImpl(this, goal, state, turn, providerName)
  }

  /** Reset conversation history (call between scenarios) */
  reset(): void {
    this.history = [];
  }

  /**
   * Pre-warm the provider connection: instantiate the model client and fire a
   * tiny generateText so DNS+TLS+HTTP/2 keep-alive are established BEFORE
   * turn 1's decide call. Without this, turn 1's first LLM call eats 600ms
   * (Anthropic) to 1200ms (OpenAI) of cold-start that has nothing to do with
   * model latency.
   *
   * Cost: ~1 input token + 1 output token per run (negligible). Skips
   * silently for CLI-spawning providers (claude-code, codex-cli) where
   * connection warmup doesn't apply, and for sandbox-backend.
   *
   * Disable via BAD_NO_WARMUP=1 if a provider rejects 1-token calls.
   */
  async warmup(): Promise<void> {
    if (process.env.BAD_NO_WARMUP === '1') return;
    if (
      this.provider === 'codex-cli'
      || this.provider === 'claude-code'
      || this.provider === 'sandbox-backend'
    ) {
      return;
    }
    try {
      const model = await this.getModel();
      // 1-token "ping" — provider charges for the input but it's the cheapest
      // possible request shape. Errors are swallowed; warmup is best-effort.
      await generateText({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        ...this.generationOptions(1),
        abortSignal: AbortSignal.timeout(10_000),
      }).catch(() => undefined);
    } catch {
      // Best-effort: any failure here just means turn 1 pays the cold-start.
    }
  }

  /** Get current conversation history */
  getHistory(): ModelMessage[] {
    return [...this.history];
  }

  /** Inject a system-level feedback message into history */
  injectFeedback(feedback: string): void {
    this.history.push({ role: 'user', content: `[SYSTEM FEEDBACK] ${feedback}` });
  }

  /**
   * Build the user message content parts — text + optional screenshot.
   * Multimodal when vision is enabled and screenshot is available.
   */
  // Public so the extracted task impls (src/brain/tasks/*) can reach it through
  // their host interfaces.
  buildUserContent(text: string, screenshot?: string, forceVision = false): UserContent {
    const shouldUseVision = !!screenshot && (
      this.visionStrategy === 'always'
      || (this.visionStrategy === 'auto' && forceVision)
    );
    if (!shouldUseVision) {
      return text;
    }

    return [
      { type: 'text' as const, text },
      {
        type: 'image' as const,
        image: screenshot,
        mediaType: 'image/jpeg',
      },
    ];
  }

  async decide(
    goal: string,
    state: PageState,
    extraContext?: string,
    turnInfo?: { current: number; max: number },
    options?: { forceVision?: boolean }
  ): Promise<BrainDecision> {
    return decideImpl(this, goal, state, extraContext, turnInfo, options);
  }

  /**
   * Vision-first decision path. The screenshot is the primary
   * observation; DOM snapshot is minimal context (URL, title only in pure
   * vision mode, or compact DOM in hybrid mode). The LLM outputs
   * coordinate-based actions (clickAt, typeAt) in 1024×768 virtual space.
   */
  private async decideVision(
    goal: string,
    state: PageState,
    extraContext?: string,
    turnInfo?: { current: number; max: number },
  ): Promise<BrainDecision> {
    return decideVisionImpl(this, goal, state, extraContext, turnInfo);
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
  async plan(
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
    return planImpl(this, goal, state, options)
  }

  /**
   * Evaluate quality of the current page state.
   * Takes a screenshot and asks the LLM to rate the visual quality,
   * design, and professional polish.
   */
  async evaluate(state: PageState, goal: string): Promise<QualityEvaluation> {
    return evaluateImpl(this, state, goal);
  }

  async recommendLinkCandidate(
    goal: string,
    state: PageState,
    candidates: Array<{ ref: string; text: string; score: number }>,
    extraContext?: string,
  ): Promise<LinkScoutRecommendation> {
    return recommendLinkCandidateImpl(this, goal, state, candidates, extraContext);
  }

  /**
   * Verify whether the goal was actually achieved.
   * Separate from quality evaluation — this checks goal completion, not polish.
   * Uses a fresh LLM call (no conversation history) to avoid self-confirmation bias.
   */
  async verifyGoalCompletion(
    state: PageState,
    goal: string,
    claimedResult: string,
  ): Promise<GoalVerification> {
    return verifyGoalCompletionImpl(this, state, goal, claimedResult);
  }

  /**
   * Audit design quality of the current page state.
   * Uses vision to analyze layout, typography, spacing, contrast, and UX.
   * Returns structured findings with categories and severity levels.
   */
  async auditDesign(
    state: PageState,
    goal: string,
    checkpoints: string[],
    systemPrompt?: string,
  ): Promise<{ score: number; findings: DesignFinding[]; raw: string; tokensUsed?: number; designSystemScore?: Record<string, unknown>; parseError?: string }> {
    return auditDesignImpl(this, state, goal, checkpoints, systemPrompt);
  }

  /**
   * Extract reusable knowledge from a completed trajectory.
   * Asks the LLM to identify patterns, timings, reliable selectors,
   * and app quirks from a successful run.
   */
  async extractKnowledge(
    trajectoryText: string,
    domain: string,
  ): Promise<Array<{ type: 'timing' | 'selector' | 'pattern' | 'quirk'; key: string; value: string }>> {
    return extractKnowledgeImpl(this, trajectoryText, domain);
  }

  /**
   * Generic text-completion entry point for non-agent uses (GEPA reflective
   * mutation, ad-hoc rubric authoring, knowledge distillation). Returns the
   * raw text + token usage; callers parse JSON themselves.
   *
   * No tool use, no decode-loop heuristics — just a single round-trip through
   * the configured provider/model.
   */
  async complete(
    system: string,
    user: string,
    options: { maxOutputTokens?: number } = {},
  ): Promise<{ text: string; tokensUsed?: number }> {
    return completeImpl(this, system, user, options);
  }

  /**
   * Multimodal sibling of {@link complete}: a single round-trip with a system
   * prompt, a user prompt, and one-or-more already-encoded images. The narrow
   * vision seam the reference-grounded taste judge binds to (one Brain per
   * `{ provider, model }` ref), built on the same private `generate` so it goes
   * through the existing provider abstraction — any vision-capable backend works.
   *
   * Images arrive ENCODED (`{ image, mediaType }`, base64/data); the disk read +
   * mediaType inference live in the judge's `createBrainVisionModel` adapter, so
   * this method does no IO. It is NOT `auditDesign` — the page-audit seam stays
   * off-limits to taste comparison by contract.
   */
  async completeVision(
    system: string,
    user: string,
    images: ReadonlyArray<{ image: string; mediaType: string }>,
    options: { maxOutputTokens?: number } = {},
  ): Promise<{ text: string; tokensUsed?: number }> {
    return completeVisionImpl(this, system, user, images, options);
  }

  private parse(raw: string): Omit<BrainDecision, 'raw' | 'tokensUsed'> {
    return parseDecision(raw);
  }
}
