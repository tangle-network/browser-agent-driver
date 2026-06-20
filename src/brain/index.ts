/**
 * LLM Decision Engine — multimodal (vision + text), planning, verification,
 * conversation history management, and quality evaluation.
 *
 * Uses Vercel AI SDK for multi-provider support (OpenAI, Anthropic, Google, Codex CLI, Claude Code).
 */

import { generateText, streamText } from 'ai';
import type { ModelMessage, LanguageModel, SystemModelMessage } from 'ai';
import type { Action, PageState, AgentConfig, DesignFinding, GoalVerification, Plan, PlanStep } from '../types.js';
import {
  resolveProviderApiKey,
  resolveProviderModelName,
  isClaudeCodeRoutedModel,
  shouldSendTemperature,
  ZAI_OPENAI_BASE_URL,
  ZAI_ANTHROPIC_BASE_URL,
} from '../provider-defaults.js';
import { buildFirstPartyBoundaryNote } from '../domain-policy.js';
import { generateWithSandboxBackend } from '../providers/sandbox-backend.js';
import { parseNextActions, validateAction } from './action-parse.js';
import { budgetSnapshot, compactFirstTurnSnapshot } from './snapshot-budget.js';
import {
  CORE_RULES,
  SEARCH_RULES,
  DATA_EXTRACTION_RULES,
  HEAVY_PAGE_RULES,
  REASONING_SUFFIX,
  SYSTEM_PROMPT,
  VISION_FIRST_PROMPT,
  UNIFIED_VISION_DOM_PROMPT,
  DATA_EXTRACTION_PATTERN,
  SEARCH_SNAPSHOT_PATTERN,
  FIRST_TURN_COMPACT_PROMPT,
  LINK_SCOUT_PROMPT,
  DESIGN_AUDIT_PROMPT,
  EVALUATE_PROMPT,
  buildPlanSystemPrompt,
} from './prompts.js';

import type { BrainDecision, QualityEvaluation, LinkScoutRecommendation, UserContent } from './types.js';
import { JSON_TEXT_OUTPUT, createForceNonStreamingFetch } from './provider-fetch.js';
import { compactHistory } from './history-compact.js';

export { budgetSnapshot } from './snapshot-budget.js';
export type { BrainDecision, QualityEvaluation, LinkScoutRecommendation } from './types.js';

export class Brain {
  private modelCache = new Map<string, LanguageModel>();
  private provider: 'openai' | 'anthropic' | 'google' | 'cli-bridge' | 'codex-cli' | 'claude-code' | 'sandbox-backend' | 'zai-coding-plan';
  private modelName: string;
  private adaptiveModelRouting: boolean;
  private navModelName?: string;
  private navProvider?: 'openai' | 'anthropic' | 'google' | 'cli-bridge' | 'codex-cli' | 'claude-code' | 'sandbox-backend' | 'zai-coding-plan';
  private explicitApiKey?: string;
  private baseUrl?: string;
  private debug: boolean;
  private history: ModelMessage[] = [];
  private maxHistoryTurns: number;
  private visionEnabled: boolean;
  private visionStrategy: 'always' | 'never' | 'auto';
  private observationMode: 'dom' | 'vision' | 'hybrid';
  // Force streaming input on claude-code so completeVision images are not dropped
  // (the Claude Code SDK omits image parts without it). Off by default; set only
  // by the vision-judge wiring. See AgentConfig.claudeCodeStreamingInput.
  private claudeCodeStreamingInput: boolean;
  private llmTimeoutMs: number;
  private compactFirstTurn: boolean;
  private lastDecisionUrl?: string;
  private systemPrompt: string;
  private scoutModelName?: string;
  private scoutProvider?: 'openai' | 'anthropic' | 'google' | 'cli-bridge' | 'codex-cli' | 'claude-code' | 'sandbox-backend' | 'zai-coding-plan';
  private scoutUseVision: boolean;
  // Per-role model overrides.
  private plannerModel?: string;
  private plannerProvider?: string;
  private verifierModel?: string;
  private verifierProvider?: string;
  private supervisorModel?: string;
  private supervisorProvider?: string;
  private sandboxBackendType?: string;
  private sandboxBackendProfile?: string;
  private sandboxBackendProvider?: string;
  // Extension-supplied rules. Set via setExtensionRules() — null/undefined
  // when no extensions are loaded (default).
  private extensionRules?: { global?: string; search?: string; dataExtraction?: string; heavy?: string };
  private extensionDomainRules?: Record<string, { extraRules?: string }>;
  /** Rendered macro prompt block; set via setMacroPromptBlock(). Empty string when no macros loaded. */
  private macroPromptBlock = '';

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

  private resolveModelName(
    provider: 'openai' | 'anthropic' | 'google' | 'cli-bridge' | 'codex-cli' | 'claude-code' | 'sandbox-backend' | 'zai-coding-plan',
    requestedModel?: string,
  ): string {
    return resolveProviderModelName(provider, requestedModel, {
      sandboxBackendType: provider === 'sandbox-backend' ? this.sandboxBackendType : undefined,
    });
  }

  private shouldSendTemperature(modelName = this.modelName): boolean {
    // Reasoning models reject an explicit temperature — see the shared
    // capability check (GPT-5, o-series, Opus 4.8+, Kimi K2.6+, DeepSeek
    // reasoner).
    return shouldSendTemperature(modelName);
  }

  private generationOptions(
    maxOutputTokens: number,
    selection?: { provider?: 'openai' | 'anthropic' | 'google' | 'cli-bridge' | 'codex-cli' | 'claude-code' | 'sandbox-backend' | 'zai-coding-plan'; model?: string },
  ): Record<string, unknown> {
    const providerName = selection?.provider || this.provider;
    const modelName = this.resolveModelName(providerName, selection?.model || this.modelName);
    // CLI-spawning providers (codex-cli, claude-code, and zai-coding-plan
    // when routed through claude-code) don't accept maxOutputTokens through
    // the AI SDK shape — the subprocess controls its own output.
    const isCliSpawning =
      providerName === 'codex-cli' ||
      providerName === 'claude-code' ||
      providerName === 'sandbox-backend' ||
      (providerName === 'zai-coding-plan' && isClaudeCodeRoutedModel(modelName));
    const omitsLegacyMaxTokens = providerName === 'cli-bridge' || /(^|\/)gpt-5(?:[.-]|$)/i.test(modelName);
    return {
      ...(this.shouldSendTemperature(modelName) ? { temperature: 0 } : {}),
      ...(isCliSpawning || omitsLegacyMaxTokens ? {} : { maxOutputTokens }),
      // forceReasoning routes the AI SDK to OpenAI's Responses API
      // (`/v1/responses`). Most third-party OpenAI-compatible proxies
      // (router.tangle.tools, LiteLLM, Together, vLLM, etc.) only implement
      // /v1/chat/completions — Responses API requests come back 503 / 4xx
      // and the SDK throws "Invalid JSON response". Disable on proxied
      // openai routes; only OpenAI direct supports the Responses API today.
      ...(providerName === 'openai'
        && /(^|\/)gpt-5(?:[.-]|$)/i.test(modelName)
        && !this.isProxiedOpenAI(providerName)
        ? {
            providerOptions: {
              openai: {
                forceReasoning: true,
                maxCompletionTokens: maxOutputTokens,
              },
            },
          }
        : {}),
    };
  }

  /**
   * True iff we're hitting an OpenAI-compatible *proxy* (router.tangle.tools,
   * LiteLLM, etc.) rather than OpenAI direct. Used to downshift to the lowest
   * common denominator API surface — chat-completions, no Responses API,
   * non-streaming — that every OpenAI-compatible proxy is guaranteed to serve.
   *
   * The single source of truth for "we're talking to a proxy, be conservative
   * about API features"; both `createForceNonStreamingFetch()` and the
   * `forceReasoning` gate route through this predicate.
   */
  private isProxiedOpenAI(providerName: string): boolean {
    return providerName === 'openai' && Boolean(this.baseUrl);
  }

  /** Get a LLM model instance, optionally with provider/model override (e.g. for CAPTCHA fallback) */
  async getLanguageModel(selection?: { provider?: 'openai' | 'anthropic' | 'google' | 'cli-bridge'; model?: string }): Promise<LanguageModel> {
    return this.getModel(selection)
  }

  /** Lazily create the LLM model instance based on provider config */
  private async getModel(selection?: { provider?: 'openai' | 'anthropic' | 'google' | 'cli-bridge' | 'codex-cli' | 'claude-code' | 'sandbox-backend' | 'zai-coding-plan'; model?: string }): Promise<LanguageModel> {
    const providerName = selection?.provider || this.provider;
    const modelName = this.resolveModelName(providerName, selection?.model || this.modelName);
    const apiKey = resolveProviderApiKey(providerName, this.explicitApiKey);
    const cacheKey = `${providerName}:${modelName}`;
    const cached = this.modelCache.get(cacheKey);
    if (cached) return cached;

    let model: LanguageModel;
    switch (providerName) {
      case 'anthropic': {
        const { createAnthropic } = await import('@ai-sdk/anthropic');
        const provider = createAnthropic({
          apiKey,
          ...(this.baseUrl ? { baseURL: this.baseUrl } : {}),
        });
        model = provider(modelName) as LanguageModel;
        break;
      }
      case 'google': {
        const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
        const provider = createGoogleGenerativeAI({
          apiKey,
          ...(this.baseUrl ? { baseURL: this.baseUrl } : {}),
        });
        model = provider(modelName) as LanguageModel;
        break;
      }
      case 'cli-bridge': {
        const { createOpenAI } = await import('@ai-sdk/openai');
        const rawUrl = this.baseUrl || process.env.CLI_BRIDGE_URL;
        if (!rawUrl) {
          throw new Error('cli-bridge provider requires CLI_BRIDGE_URL or --base-url');
        }
        const baseURL = rawUrl.endsWith('/v1') ? rawUrl : `${rawUrl.replace(/\/+$/, '')}/v1`;
        const provider = createOpenAI({
          apiKey: apiKey || '',
          baseURL,
        });
        model = provider.chat(modelName) as LanguageModel;
        break;
      }
      case 'codex-cli': {
        const { codexExec } = await import('ai-sdk-provider-codex-cli');
        const env: Record<string, string> = {};
        if (apiKey) env.OPENAI_API_KEY = apiKey;
        model = codexExec(modelName, {
          allowNpx: process.env.CODEX_ALLOW_NPX !== '0',
          skipGitRepoCheck: true,
          ...(process.env.CODEX_CLI_PATH ? { codexPath: process.env.CODEX_CLI_PATH } : {}),
          ...(Object.keys(env).length > 0 ? { env } : {}),
        }) as LanguageModel;
        break;
      }
      case 'claude-code': {
        const { createClaudeCode } = await import('ai-sdk-provider-claude-code');
        const env: Record<string, string> = {};
        if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
        const provider = createClaudeCode({
          defaultSettings: {
            ...(process.env.CLAUDE_CODE_CLI_PATH ? { pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_CLI_PATH } : {}),
            permissionMode: 'default',
            allowDangerouslySkipPermissions: false,
            // The Claude Code SDK only forwards image parts when streaming input
            // is on; the vision-judge wiring sets this so completeVision images
            // are not silently dropped. Left off for every other claude-code path.
            ...(this.claudeCodeStreamingInput ? { streamingInput: 'always' as const } : {}),
            ...(this.debug ? { verbose: true } : {}),
            ...(this.debug
              ? {
                  stderr: (chunk: string) => {
                    const line = chunk.trim();
                    if (line) console.error(`[claude-code] ${line}`);
                  },
                }
              : {}),
            ...(Object.keys(env).length > 0 ? { env } : {}),
          },
        });
        model = provider(modelName) as LanguageModel;
        break;
      }
      case 'zai-coding-plan': {
        // Z.ai coding plan: GLM models (glm-4.6, glm-4.5-air) at a fraction
        // of Anthropic prices. Two backends:
        //   1. Default — OpenAI-compatible endpoint, native GLM models
        //   2. claude-code routed — spawn the Claude Code CLI subprocess
        //      with ANTHROPIC_BASE_URL/AUTH_TOKEN env vars pointed at Z.ai's
        //      Anthropic-compatible endpoint. The user gets the Claude Code
        //      agent loop with Z.ai pricing.
        if (!apiKey) {
          throw new Error(
            'zai-coding-plan: API key required (set ZAI_API_KEY env var or pass --api-key)',
          );
        }
        if (isClaudeCodeRoutedModel(modelName)) {
          const { createClaudeCode } = await import('ai-sdk-provider-claude-code');
          const env: Record<string, string> = {
            // Override Claude Code's API base + auth at the env-var level.
            // The CLI subprocess inherits these and routes all Anthropic
            // API calls to Z.ai's Anthropic-compatible endpoint.
            ANTHROPIC_BASE_URL: ZAI_ANTHROPIC_BASE_URL,
            ANTHROPIC_AUTH_TOKEN: apiKey,
            // Some Claude Code versions still read ANTHROPIC_API_KEY — set
            // both so we don't depend on which env var name wins.
            ANTHROPIC_API_KEY: apiKey,
          };
          const provider = createClaudeCode({
            defaultSettings: {
              ...(process.env.CLAUDE_CODE_CLI_PATH ? { pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_CLI_PATH } : {}),
              permissionMode: 'default',
              allowDangerouslySkipPermissions: false,
              ...(this.debug ? { verbose: true } : {}),
              ...(this.debug
                ? {
                    stderr: (chunk: string) => {
                      const line = chunk.trim();
                      if (line) console.error(`[zai-claude-code] ${line}`);
                    },
                  }
                : {}),
              env,
            },
          });
          // The Claude Code SDK takes a model alias (sonnet/haiku/opus); when
          // the user passes a glm-* name we just hand it through — Claude
          // Code passes it as the model param to the upstream API, which is
          // Z.ai's Anthropic-compat endpoint that maps it to the right glm.
          // For 'claude-code'/'cc' we default to 'sonnet' which Z.ai aliases
          // to its strongest glm model under the coding plan.
          const ccModel = modelName === 'claude-code' || modelName === 'cc' ? 'sonnet' : modelName;
          model = provider(ccModel) as LanguageModel;
          break;
        }
        // Default path — direct OpenAI-compatible API to Z.ai. Z.ai's
        // paas/v4 endpoint only implements `/chat/completions` (no
        // `/responses`), so we MUST use `provider.chat(model)` rather than
        // the bare `provider(model)` call which now defaults to the new
        // OpenAI Responses API in @ai-sdk/openai v3+.
        const { createOpenAI } = await import('@ai-sdk/openai');
        const provider = createOpenAI({
          apiKey,
          baseURL: ZAI_OPENAI_BASE_URL,
        });
        model = provider.chat(modelName) as LanguageModel;
        break;
      }
      default: {
        // 'openai' or any OpenAI-compatible API (LiteLLM, Together, etc.).
        // Same reason as the zai-coding-plan branch above: most third-party
        // OpenAI-compatible proxies (LiteLLM, vLLM, Together) implement
        // `/chat/completions` but not the new `/responses` API. Use the
        // chat factory explicitly so we hit a path the upstream actually
        // serves.
        const { createOpenAI } = await import('@ai-sdk/openai');
        const usingProxy = this.isProxiedOpenAI(providerName);
        const provider = createOpenAI({
          apiKey: apiKey || '',
          ...(this.baseUrl ? { baseURL: this.baseUrl } : {}),
          // Proxy downshift — see isProxiedOpenAI(). Routes like
          // router.tangle.tools default chat-completions to SSE when the
          // client omits `stream`, and the AI SDK's generateText errors with
          // "Invalid JSON response" on SSE. Force stream: false on every
          // chat-completions body. Paired with the forceReasoning gate in
          // generationOptions() so all "talk to a proxy" downshifts share
          // one predicate.
          ...(usingProxy ? { fetch: createForceNonStreamingFetch() } : {}),
        });
        model = provider.chat(modelName) as LanguageModel;
        break;
      }
    }

    this.modelCache.set(cacheKey, model);
    return model;
  }

  private async generate(
    system: string | SystemModelMessage[],
    messages: ModelMessage[],
    selection?: { provider?: 'openai' | 'anthropic' | 'google' | 'cli-bridge' | 'codex-cli' | 'claude-code' | 'sandbox-backend' | 'zai-coding-plan'; model?: string },
    maxOutputTokens = 800,
  ): Promise<{ text: string; tokensUsed?: number; inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }> {
    const providerName = selection?.provider || this.provider;
    const modelName = this.resolveModelName(providerName, selection?.model || this.modelName);

    // Sandbox backend doesn't accept structured system messages — flatten.
    const systemForSandbox = typeof system === 'string'
      ? system
      : system.map(m => m.content).join('\n\n');

    if (providerName === 'sandbox-backend') {
      const result = await generateWithSandboxBackend({
        system: systemForSandbox,
        messages,
        model: modelName,
        timeoutMs: this.llmTimeoutMs,
        debug: this.debug,
        backendType: this.sandboxBackendType,
        backendProfile: this.sandboxBackendProfile,
        backendModelProvider: this.sandboxBackendProvider,
      });
      return { text: result.text };
    }

    const model = await this.getModel({
      provider: providerName,
      model: modelName,
    });

    // Anthropic supports structured system messages with cache_control. For
    // every other provider, flatten back to a string — they ignore the array
    // form's per-message provider options anyway, and some (claude-code,
    // codex-cli) wrap their own subprocess CLI which only takes plain text.
    const systemForRequest = providerName === 'anthropic' || typeof system === 'string'
      ? system
      : systemForSandbox;

    const generationSettings = {
      model,
      system: systemForRequest,
      messages,
      ...(providerName === 'cli-bridge' ? { output: JSON_TEXT_OUTPUT } : {}),
      ...this.generationOptions(maxOutputTokens, { provider: providerName, model: modelName }),
      abortSignal: AbortSignal.timeout(this.llmTimeoutMs),
    };
    const result = providerName === 'cli-bridge'
      ? await (async () => {
          const streamed = streamText(generationSettings);
          const [text, usage, providerMetadata] = await Promise.all([
            streamed.text,
            streamed.totalUsage,
            streamed.providerMetadata,
          ]);
          return { text, usage, providerMetadata };
        })()
      : await generateText(generationSettings);

    // Extract prompt-cache stats from the AI SDK's PROVIDER-AGNOSTIC fields:
    //   result.usage.inputTokenDetails.{cacheReadTokens, cacheWriteTokens}
    //
    // These flow uniformly from every provider that supports prompt caching:
    //   - OpenAI (gpt-5.4, gpt-4.1-mini): AUTOMATIC server-side caching for
    //     >1024 token prefixes, no markers needed. Returns cached_tokens.
    //   - Anthropic (claude-*): EXPLICIT cache_control markers required (we
    //     set them in buildSystemForDecide). Returns cache_read_input_tokens.
    //   - ZAI / GLM (zai-coding-plan via OpenAI-compatible endpoint): AUTOMATIC
    //     server-side caching, returns cached_tokens in prompt_tokens_details.
    //   - Google Gemini: explicit `cachedContent` ID-based caching (different
    //     paradigm — not currently exercised).
    //
    // The unified inputTokenDetails fields mean we get cache observability
    // for free across providers without per-provider extraction code.
    const inputDetails = result.usage?.inputTokenDetails as
      | { cacheReadTokens?: number | null; cacheWriteTokens?: number | null }
      | undefined;
    let cacheReadInputTokens = typeof inputDetails?.cacheReadTokens === 'number'
      ? inputDetails.cacheReadTokens
      : undefined;
    let cacheCreationInputTokens = typeof inputDetails?.cacheWriteTokens === 'number'
      ? inputDetails.cacheWriteTokens
      : undefined;
    // Fallback: some providers expose cache stats only via providerMetadata.
    // Anthropic uses cacheReadInputTokens / cacheCreationInputTokens directly,
    // OpenAI sometimes lands cached_tokens under providerMetadata.openai.
    if (cacheReadInputTokens === undefined || cacheCreationInputTokens === undefined) {
      const meta = result.providerMetadata as Record<string, Record<string, unknown>> | undefined;
      const anthropicMeta = meta?.anthropic;
      const openaiMeta = meta?.openai;
      if (cacheReadInputTokens === undefined) {
        const fromAnthropic = typeof anthropicMeta?.cacheReadInputTokens === 'number'
          ? (anthropicMeta.cacheReadInputTokens as number)
          : undefined;
        const fromOpenAI = typeof openaiMeta?.cachedPromptTokens === 'number'
          ? (openaiMeta.cachedPromptTokens as number)
          : undefined;
        cacheReadInputTokens = fromAnthropic ?? fromOpenAI;
      }
      if (cacheCreationInputTokens === undefined) {
        const fromAnthropic = typeof anthropicMeta?.cacheCreationInputTokens === 'number'
          ? (anthropicMeta.cacheCreationInputTokens as number)
          : undefined;
        cacheCreationInputTokens = fromAnthropic;
      }
    }

    return {
      text: result.text,
      tokensUsed: result.usage?.totalTokens,
      inputTokens: result.usage?.inputTokens ?? undefined,
      outputTokens: result.usage?.outputTokens ?? undefined,
      cacheReadInputTokens,
      cacheCreationInputTokens,
    };
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
  private shouldUseNavigationModel(
    state: PageState,
    extraContext?: string,
    turnInfo?: { current: number; max: number },
  ): boolean {
    if (!this.adaptiveModelRouting || !this.navModelName) return false;
    // Use the navigation model for DOM-only same-page turns. Keep the primary
    // model for first turns, new pages, and error recovery.
    const isFirstTurn = !turnInfo || turnInfo.current <= 1;
    const samePageAsPrevious = this.lastDecisionUrl === state.url;
    const hasError = extraContext?.includes('REJECTED') || extraContext?.includes('ERROR');
    if (isFirstTurn || !samePageAsPrevious || hasError) return false;
    return true;
  }

  /**
   * Build the system prompt dynamically, injecting conditional rule groups
   * based on goal text, page snapshot content, and turn number.
   * Saves ~800 tokens per turn on simple navigation tasks.
   */
  private buildSystemPrompt(goal: string, state: PageState, turn: number): string {
    return this.composeSystemPromptParts(goal, state, turn).join('')
  }

  /**
   * Same as buildSystemPrompt but returns the parts so the caller can decide
   * how to send them. For Anthropic, decide() ships them as a SystemModelMessage[]
   * with cache_control on the stable CORE_RULES prefix; other providers join.
   *
   * The first slot is ALWAYS CORE_RULES (or the user's custom override) so the
   * cache breakpoint placement is deterministic. Extension-supplied rules are
   * appended AFTER REASONING_SUFFIX so the cached prefix stays byte-stable
   * across turns.
   */
  private composeSystemPromptParts(goal: string, state: PageState, turn: number): string[] {
    if (this.systemPrompt !== SYSTEM_PROMPT) return [this.systemPrompt]

    const parts: string[] = [CORE_RULES]
    const snapshotSample = state.snapshot.length > 4000 ? state.snapshot.slice(0, 4000) : state.snapshot
    if (SEARCH_SNAPSHOT_PATTERN.test(snapshotSample) || /\/search\b/i.test(state.url)) {
      parts.push(SEARCH_RULES)
      if (this.extensionRules?.search) {
        parts.push(`\n\nUSER RULES (search):\n${this.extensionRules.search}`)
      }
    }
    if (DATA_EXTRACTION_PATTERN.test(goal)) {
      parts.push(DATA_EXTRACTION_RULES)
      if (this.extensionRules?.dataExtraction) {
        parts.push(`\n\nUSER RULES (data extraction):\n${this.extensionRules.dataExtraction}`)
      }
    }
    if (state.snapshot.length > 10_000 || turn > 10) {
      parts.push(HEAVY_PAGE_RULES)
      if (this.extensionRules?.heavy) {
        parts.push(`\n\nUSER RULES (heavy page):\n${this.extensionRules.heavy}`)
      }
    }
    parts.push(REASONING_SUFFIX)

    // Global user rules + matching per-domain rules. Both are appended AFTER
    // REASONING_SUFFIX so they don't pollute the byte-stable cached prefix.
    if (this.extensionRules?.global) {
      parts.push(`\n\nUSER RULES (global):\n${this.extensionRules.global}`)
    }
    if (this.extensionDomainRules) {
      const domainRules = this.matchDomainRules(state.url)
      if (domainRules) {
        parts.push(`\n\nUSER RULES (domain match):\n${domainRules}`)
      }
    }
    // Macros live AFTER the cached prefix so registering new macros
    // doesn't bust the Anthropic cache.
    if (this.macroPromptBlock) {
      parts.push(`\n\n${this.macroPromptBlock}`)
    }
    return parts
  }

  /**
   * Find the per-domain extra rules whose domain key matches the URL host.
   * Multiple matches are concatenated in registration order.
   */
  private matchDomainRules(url: string): string | undefined {
    if (!this.extensionDomainRules) return undefined
    let host: string
    try {
      host = new URL(url).hostname
    } catch {
      return undefined
    }
    const matches: string[] = []
    for (const [domain, rules] of Object.entries(this.extensionDomainRules)) {
      if (host.includes(domain) && rules.extraRules) {
        matches.push(rules.extraRules)
      }
    }
    return matches.length > 0 ? matches.join('\n\n') : undefined
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
  private buildSystemForDecide(
    goal: string,
    state: PageState,
    turn: number,
    providerName: 'openai' | 'anthropic' | 'google' | 'cli-bridge' | 'codex-cli' | 'claude-code' | 'sandbox-backend' | 'zai-coding-plan',
  ): string | SystemModelMessage[] {
    const parts = this.composeSystemPromptParts(goal, state, turn)
    if (providerName !== 'anthropic' || this.systemPrompt !== SYSTEM_PROMPT || parts.length === 0) {
      return parts.join('')
    }
    // Anthropic path: first slot is CORE_RULES (cached), remaining parts ship
    // as a separate uncached system message so the prefix stays byte-stable
    // across turns and the cache hits.
    const corePart: SystemModelMessage = {
      role: 'system',
      content: parts[0],
      providerOptions: {
        anthropic: {
          cacheControl: { type: 'ephemeral' },
        },
      },
    }
    if (parts.length === 1) return [corePart]
    return [corePart, { role: 'system', content: parts.slice(1).join('') }]
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
  private buildUserContent(text: string, screenshot?: string, forceVision = false): UserContent {
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

  /** Compact conversation history (see history-compact.ts). */
  private compactHistory(): ModelMessage[] {
    return compactHistory(this.history);
  }

  async decide(
    goal: string,
    state: PageState,
    extraContext?: string,
    turnInfo?: { current: number; max: number },
    options?: { forceVision?: boolean }
  ): Promise<BrainDecision> {
    // Vision-first and hybrid modes delegate to the vision path.
    if (this.observationMode === 'vision' || this.observationMode === 'hybrid') {
      return this.decideVision(goal, state, extraContext, turnInfo);
    }

    const useCompactFirstTurn = this.compactFirstTurn && turnInfo?.current === 1;
    const samePageAsPrevious = this.lastDecisionUrl === state.url;
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
    this.lastDecisionUrl = state.url;

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

    const userContent = this.buildUserContent(textContent, state.screenshot, options?.forceVision === true);
    const useNavModel = this.shouldUseNavigationModel(state, extraContext, turnInfo);
    const effectiveProvider = useNavModel ? (this.navProvider || this.provider) : this.provider;
    const effectiveModel = useNavModel ? (this.navModelName || this.modelName) : this.modelName;

    if (this.debug) {
      const turnNum = Math.floor(this.history.length / 2) + 1;
      const usingVision = !!state.screenshot && (
        this.visionStrategy === 'always' || (this.visionStrategy === 'auto' && options?.forceVision === true)
      );
      console.log(`[Brain] Turn ${turnNum} | URL: ${state.url} | Vision: ${usingVision}`);
      if (this.adaptiveModelRouting) {
        const mode = useNavModel ? 'nav-model' : 'primary-model';
        console.log(`[Brain] Model route: ${mode} (${effectiveProvider}/${effectiveModel}) turn=${turnInfo?.current}/${turnInfo?.max}`);
      }
    }

    const messages: ModelMessage[] = [
      ...this.compactHistory(),
      { role: 'user', content: userContent },
    ];

    const dynamicSystemPrompt: string | SystemModelMessage[] = useCompactFirstTurn
      ? FIRST_TURN_COMPACT_PROMPT
      : this.buildSystemForDecide(goal, state, turnInfo?.current ?? 1, effectiveProvider)

    const modelOpts = { provider: effectiveProvider, model: effectiveModel };
    // Bump output budget near max turns so data-heavy completions don't truncate
    const nearingEnd = turnInfo && turnInfo.current >= turnInfo.max - 3;
    const maxTokens = useCompactFirstTurn ? 500 : nearingEnd ? 1200 : 600;
    const result = await this.generate(dynamicSystemPrompt, messages, modelOpts, maxTokens);

    let raw = result.text;
    let tokensUsed = result.tokensUsed;
    let inputTokens = result.inputTokens;
    let outputTokens = result.outputTokens;
    let cacheReadInputTokens = result.cacheReadInputTokens;
    let cacheCreationInputTokens = result.cacheCreationInputTokens;

    if (!raw) {
      throw new Error('Brain.decide: LLM returned empty response — possible rate limit or model error');
    }

    if (this.debug) {
      console.log('[Brain] Response:', raw.slice(0, 300));
    }

    let parsed = this.parse(raw);

    // On malformed JSON, retry with minimal context (current page + correction
    // hint) instead of burning a full turn. Costs ~7K tokens vs ~25K for a
    // full-history retry on the next turn.
    if (parsed.reasoning?.startsWith('Malformed LLM JSON response') && !useCompactFirstTurn) {
      if (this.debug) {
        console.log('[Brain] Malformed JSON — retrying with format hint');
      }
      const retryMessages: ModelMessage[] = [
        { role: 'user', content: userContent },
        { role: 'assistant', content: raw },
        { role: 'user', content: 'Your previous response was not valid JSON. Respond with ONLY a valid JSON object matching the required schema.' },
      ];
      try {
        const retryResult = await this.generate(dynamicSystemPrompt, retryMessages, modelOpts, maxTokens);
        if (retryResult.text) {
          const retryParsed = this.parse(retryResult.text);
          if (!retryParsed.reasoning?.startsWith('Malformed LLM JSON response')) {
            raw = retryResult.text;
            parsed = retryParsed;
          } else if (this.baseUrl) {
            // Both the initial parse and the format-hint retry failed while a
            // custom LLM_BASE_URL is set. Strong signal the gateway is
            // returning a shape the scout can't consume (e.g. SSE streams,
            // non-JSON wrappers). Surface the likely cause instead of
            // burning silent retries turn after turn.
            console.error(
              `[Brain] scout_json_parse_failed: LLM_BASE_URL=${this.baseUrl} returned a response the scout could not parse even after a format-hint retry. ` +
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
    this.history.push({ role: 'user', content: userContent });
    this.history.push({ role: 'assistant', content: raw });

    // Trim old history
    const maxMessages = this.maxHistoryTurns * 2;
    if (this.history.length > maxMessages) {
      this.history = this.history.slice(-maxMessages);
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
  private async decideVision(
    goal: string,
    state: PageState,
    extraContext?: string,
    turnInfo?: { current: number; max: number },
  ): Promise<BrainDecision> {
    this.lastDecisionUrl = state.url;

    // Adaptive observation: on same-page hybrid turns, send only changed
    // elements when the diff is small.
    const isHybrid = this.observationMode === 'hybrid';
    const samePageAsPrevious = this.lastDecisionUrl === state.url;
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
    const compacted = this.compactHistory().map((msg) => {
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
    const modelOpts = { provider: this.provider, model: this.modelName };
    const nearingEnd = turnInfo && turnInfo.current >= turnInfo.max - 3;
    const maxTokens = nearingEnd ? 1200 : 600;
    // Hybrid mode uses the unified prompt with both action vocabularies.
    const systemPrompt = isHybrid ? UNIFIED_VISION_DOM_PROMPT : VISION_FIRST_PROMPT;
    const result = await this.generate(systemPrompt, messages, modelOpts, maxTokens);

    const raw = result.text;
    if (!raw) {
      throw new Error('Brain.decideVision: LLM returned empty response');
    }

    if (this.debug) {
      console.log('[Brain/Vision] Response:', raw.slice(0, 300));
    }

    const parsed = this.parse(raw);

    this.history.push({ role: 'user', content: userContent });
    this.history.push({ role: 'assistant', content: raw });

    const maxMessages = this.maxHistoryTurns * 2;
    if (this.history.length > maxMessages) {
      this.history = this.history.slice(-maxMessages);
    }

    return {
      ...parsed,
      raw,
      tokensUsed: result.tokensUsed,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheReadInputTokens: result.cacheReadInputTokens,
      cacheCreationInputTokens: result.cacheCreationInputTokens,
      modelUsed: this.modelName,
    };
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
    const isVisionPlanner = (this.observationMode === 'hybrid' || this.observationMode === 'vision') && !!state.screenshot;
    const userContent: UserContent = isVisionPlanner
      ? [
          { type: 'text' as const, text: userText },
          { type: 'image' as const, image: state.screenshot!, mediaType: 'image/jpeg' },
        ]
      : userText;

    // Planner can use its own model override.
    const planModelOpts = this.plannerModel
      ? { provider: (this.plannerProvider || this.provider) as typeof this.provider, model: this.plannerModel }
      : { provider: this.provider, model: this.modelName };
    const result = await this.generate(
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

  /**
   * Evaluate quality of the current page state.
   * Takes a screenshot and asks the LLM to rate the visual quality,
   * design, and professional polish.
   */
  async evaluate(state: PageState, goal: string): Promise<QualityEvaluation> {
    const textContent = `GOAL that was being worked on: ${goal}

CURRENT PAGE:
URL: ${state.url}
Title: ${state.title}

Please evaluate the quality of this page/application.`;

    const userContent = this.buildUserContent(textContent, state.screenshot, true);

    const result = await this.generate(
      EVALUATE_PROMPT,
      [{ role: 'user', content: userContent }],
      undefined,
      800,
    );

    const raw = result.text;
    const tokensUsed = result.tokensUsed;

    if (this.debug) {
      console.log('[Brain] Evaluation:', raw.slice(0, 300));
    }

    try {
      let text = raw.trim();
      if (text.startsWith('```')) {
        text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      const parsed = JSON.parse(text);
      const rawScore = typeof parsed.score === 'number' ? parsed.score : 5;
      return {
        score: Math.max(1, Math.min(10, rawScore)),
        assessment: parsed.assessment ?? 'No assessment provided',
        strengths: Array.isArray(parsed.strengths) ? parsed.strengths : [],
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
        raw,
        tokensUsed,
      };
    } catch {
      return {
        score: 5,
        assessment: 'Failed to parse evaluation response',
        strengths: [],
        issues: [],
        suggestions: [],
        raw,
        tokensUsed,
      };
    }
  }

  async recommendLinkCandidate(
    goal: string,
    state: PageState,
    candidates: Array<{ ref: string; text: string; score: number }>,
    extraContext?: string,
  ): Promise<LinkScoutRecommendation> {
    const topCandidates = candidates.slice(0, 5);
    // Scout only needs candidates + context, not the full snapshot (saves 2-8k tokens)
    const lines = [
      `GOAL: ${goal}`,
      '',
      `PAGE: ${state.url} — ${state.title}`,
      '',
      'CANDIDATES:',
      ...topCandidates.map((candidate, index) =>
        `${index + 1}. ${candidate.ref} — ${candidate.text} (score ${candidate.score})`,
      ),
    ];
    if (extraContext) {
      lines.push('', extraContext);
    }
    lines.push('', 'Choose the single best next visible link.');

    const userContent = this.buildUserContent(
      lines.join('\n'),
      state.screenshot,
      this.scoutUseVision,
    );
    const provider = this.scoutProvider || this.navProvider || this.provider;
    const model = this.scoutModelName || this.navModelName || this.modelName;
    const result = await this.generate(
      LINK_SCOUT_PROMPT,
      [{ role: 'user', content: userContent }],
      { provider, model },
      300,
    );

    const raw = result.text;
    const tokensUsed = result.tokensUsed;

    try {
      let text = raw.trim();
      if (text.startsWith('```')) {
        text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      const parsed = JSON.parse(text);
      const selector = typeof parsed.selector === 'string' ? parsed.selector.trim() : '';
      const candidate = topCandidates.find((entry) => entry.ref === selector);
      if (!candidate) {
        throw new Error('invalid scout selector');
      }
      return {
        selector,
        reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : 'No scout reasoning provided.',
        confidence: typeof parsed.confidence === 'number'
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0.5,
        raw,
        tokensUsed,
      };
    } catch {
      const fallback = topCandidates[0];
      if (!fallback) {
        throw new Error('recommendLinkCandidate requires at least one candidate');
      }
      return {
        selector: fallback.ref,
        reasoning: 'Scout fallback: selected the top deterministic candidate after parse failure.',
        confidence: 0.5,
        raw,
        tokensUsed,
      };
    }
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
    const siteBoundaryNote = buildFirstPartyBoundaryNote(goal, state.url);
    const textContent = `GOAL: ${goal}

AGENT'S CLAIMED RESULT: ${claimedResult}

CURRENT PAGE:
URL: ${state.url}
Title: ${state.title}

ELEMENTS:
${budgetSnapshot(state.snapshot)}${siteBoundaryNote ? `\n\n${siteBoundaryNote}` : ''}

Was the goal actually achieved? Analyze the current page state carefully.`;

    const userContent = this.buildUserContent(textContent, state.screenshot, true);

    // Verifier can use its own model, then the navigation model, then main.
    const verifyProvider = this.verifierProvider
      ? this.verifierProvider as typeof this.provider
      : (this.adaptiveModelRouting && this.navModelName ? (this.navProvider || this.provider) : undefined);
    const verifyModel = this.verifierModel
      || (this.adaptiveModelRouting && this.navModelName ? this.navModelName : undefined);

    const result = await this.generate(
      `Verify whether the browser agent achieved its goal. Respond with ONLY JSON:
{"achieved":true,"confidence":0.9,"evidence":["observation"],"missing":[]}

Check: page state matches goal, no errors, URL is expected, claimed result matches visible data.
SUPPLEMENTAL TOOL EVIDENCE / SCRIPT RESULT in claimed results = verified DOM data, trustworthy even if page navigated away. Multi-page data collection is valid.`,
      [{ role: 'user', content: userContent }],
      verifyProvider && verifyModel ? { provider: verifyProvider, model: verifyModel } : undefined,
      600,
    );

    const raw = result.text;

    if (this.debug) {
      console.log('[Brain] Goal verification:', raw.slice(0, 300));
    }

    try {
      let text = raw.trim();
      if (text.startsWith('```')) {
        text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      const parsed = JSON.parse(text);
      return {
        achieved: parsed.achieved === true,
        confidence: typeof parsed.confidence === 'number'
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0.5,
        evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
        missing: Array.isArray(parsed.missing) ? parsed.missing : [],
      };
    } catch {
      // Parse failure — assume not verified (conservative)
      return {
        achieved: false,
        confidence: 0,
        evidence: [],
        missing: ['Failed to parse goal verification response'],
      };
    }
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
    const textContent = `GOAL: ${goal}

CHECKPOINTS to verify:
${checkpoints.map((c, i) => `${i + 1}. ${c}`).join('\n')}

CURRENT PAGE:
URL: ${state.url}
Title: ${state.title}

ELEMENTS:
${state.snapshot}

Audit this page for design quality, UX issues, and visual bugs.`;

    const userContent = this.buildUserContent(textContent, state.screenshot, true);

    const result = await this.generate(
      systemPrompt ?? DESIGN_AUDIT_PROMPT,
      [{ role: 'user', content: userContent }],
      undefined,
      8000,
    );

    const raw = result.text;
    const tokensUsed = result.tokensUsed;

    if (this.debug) {
      console.log('[Brain] Design audit:', raw.slice(0, 300));
    }

    try {
      let text = raw.trim();
      if (text.startsWith('```')) {
        text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      // Extract JSON object if surrounded by non-JSON text or truncated
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text);
      } catch {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start >= 0 && end > start) {
          parsed = JSON.parse(text.slice(start, end + 1));
        } else {
          throw new Error('No JSON object found');
        }
      }

      const VALID_CATEGORIES = new Set(['visual-bug', 'layout', 'contrast', 'alignment', 'spacing', 'typography', 'accessibility', 'ux']);
      const VALID_SEVERITIES = new Set(['critical', 'major', 'minor']);

      const VALID_BLAST = new Set(['page', 'section', 'component', 'system']);
      const clampScore = (n: unknown): number | undefined =>
        typeof n === 'number' ? Math.max(1, Math.min(10, n)) : undefined;

      const findings: DesignFinding[] = Array.isArray(parsed.findings)
        ? parsed.findings.map((f: Record<string, unknown>) => ({
            category: (VALID_CATEGORIES.has(f.category as string) ? f.category : 'ux') as DesignFinding['category'],
            severity: (VALID_SEVERITIES.has(f.severity as string) ? f.severity : 'minor') as DesignFinding['severity'],
            description: String(f.description ?? ''),
            location: String(f.location ?? ''),
            suggestion: String(f.suggestion ?? ''),
            ...(f.cssSelector ? { cssSelector: String(f.cssSelector) } : {}),
            ...(f.cssFix ? { cssFix: String(f.cssFix) } : {}),
            // Optional ROI fields.
            ...(clampScore(f.impact) !== undefined ? { impact: clampScore(f.impact) } : {}),
            ...(clampScore(f.effort) !== undefined ? { effort: clampScore(f.effort) } : {}),
            ...(VALID_BLAST.has(f.blast as string)
              ? { blast: f.blast as DesignFinding['blast'] }
              : {}),
            // Layer 2 — preserve raw patches array (untyped passthrough). The
            // parsePatches/validatePatch pipeline in build-result.ts converts
            // these into typed, validated Patch objects.
            ...(Array.isArray(f.patches) ? { rawPatches: f.patches as unknown[] } : {}),
          }))
        : [];

      const designSystemScore = parsed.designSystemScore && typeof parsed.designSystemScore === 'object'
        ? parsed.designSystemScore as Record<string, unknown>
        : undefined;

      const rawScore = typeof parsed.score === 'number' ? parsed.score : 5;
      return {
        score: Math.max(1, Math.min(10, rawScore)),
        findings,
        raw,
        tokensUsed,
        designSystemScore,
      };
    } catch (err) {
      return {
        score: 5,
        findings: [],
        raw,
        tokensUsed,
        parseError: err instanceof Error ? err.message : String(err),
      };
    }
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
    const result = await this.generate(
      `You are analyzing a browser automation trajectory to extract reusable knowledge.
Extract facts that would help an agent complete similar tasks faster next time.

Respond with ONLY a JSON array of facts:
[
  {"type": "timing", "key": "page-load", "value": "wait 3000ms after navigation for content to hydrate"},
  {"type": "selector", "key": "send-button", "value": "[data-testid='chat-send-button'] is the reliable send button selector"},
  {"type": "pattern", "key": "auth-flow", "value": "Click sign-in → fill email → fill password → click submit → wait for redirect"},
  {"type": "quirk", "key": "lazy-loading", "value": "File tree loads asynchronously — wait for entries before asserting"}
]

Types:
- timing: wait durations, delays that are necessary
- selector: reliable selectors for important elements
- pattern: multi-step interaction sequences
- quirk: app-specific behaviors or gotchas

Only include facts that are genuinely useful. Quality over quantity. Max 10 facts.`,
      [{
        role: 'user',
        content: `Domain: ${domain}\n\nTrajectory:\n${trajectoryText}`,
      }],
      undefined,
      800,
    );

    try {
      let text = result.text.trim();
      if (text.startsWith('```')) {
        text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) return [];

      const VALID_TYPES = new Set(['timing', 'selector', 'pattern', 'quirk']);
      return parsed
        .filter((f: Record<string, unknown>) =>
          VALID_TYPES.has(f.type as string) &&
          typeof f.key === 'string' &&
          typeof f.value === 'string'
        )
        .map((f: Record<string, unknown>) => ({
          type: f.type as 'timing' | 'selector' | 'pattern' | 'quirk',
          key: f.key as string,
          value: f.value as string,
        }));
    } catch {
      return [];
    }
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
    const result = await this.generate(
      system,
      [{ role: 'user', content: user }],
      undefined,
      options.maxOutputTokens ?? 1500,
    );
    return { text: result.text, tokensUsed: result.tokensUsed };
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
    const content: UserContent = [
      { type: 'text' as const, text: user },
      ...images.map((img) => ({ type: 'image' as const, image: img.image, mediaType: img.mediaType })),
    ];
    const result = await this.generate(
      system,
      [{ role: 'user', content }],
      undefined,
      options.maxOutputTokens ?? 1500,
    );
    return { text: result.text, tokensUsed: result.tokensUsed };
  }

  private parse(raw: string): Omit<BrainDecision, 'raw' | 'tokensUsed'> {
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
}
