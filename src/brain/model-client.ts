/**
 * Transport layer for the Brain decision engine: provider/model-name
 * resolution, lazy (cached) model-client instantiation, and the single
 * `generate()` round-trip every Brain method funnels through.
 *
 * Extracted from brain/index.ts via the delegate + host-interface pattern.
 * The Brain class keeps thin delegators; these free functions hold the method
 * bodies verbatim and read Brain state through {@link BrainModelHost}. tsc
 * proves the host surface is complete because Brain `implements` it.
 */

import { generateText, streamText } from 'ai';
import type { ModelMessage, LanguageModel, SystemModelMessage } from 'ai';
import {
  resolveProviderApiKey,
  resolveProviderModelName,
  isClaudeCodeRoutedModel,
  shouldSendTemperature,
  ZAI_OPENAI_BASE_URL,
  ZAI_ANTHROPIC_BASE_URL,
} from '../provider-defaults.js';
import { generateWithSandboxBackend } from '../providers/sandbox-backend.js';
import { loadOptionalModule } from '../optional-dependency.js';
import { JSON_TEXT_OUTPUT, createForceNonStreamingFetch } from './provider-fetch.js';
import type { UserContent } from './types.js';

export type BrainProvider =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'cli-bridge'
  | 'codex-cli'
  | 'claude-code'
  | 'sandbox-backend'
  | 'zai-coding-plan';

export type ModelSelection = { provider?: BrainProvider; model?: string };

export interface GenerateResult {
  text: string;
  tokensUsed?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/**
 * The slice of Brain state the transport layer reads/writes. Brain declares
 * `implements BrainModelHost`, so a missing or mistyped member is a compile
 * error — this interface IS the safety gate for the extraction. All members
 * are public on Brain by construction.
 */
export interface BrainModelHost {
  provider: BrainProvider;
  modelName: string;
  explicitApiKey?: string;
  baseUrl?: string;
  debug: boolean;
  llmTimeoutMs: number;
  modelCache: Map<string, LanguageModel>;
  claudeCodeStreamingInput: boolean;
  sandboxBackendType?: string;
  sandboxBackendProfile?: string;
  sandboxBackendProvider?: string;
}

export function resolveModelNameImpl(
  self: BrainModelHost,
  provider: BrainProvider,
  requestedModel?: string,
): string {
  return resolveProviderModelName(provider, requestedModel, {
    sandboxBackendType: provider === 'sandbox-backend' ? self.sandboxBackendType : undefined,
  });
}

export function shouldSendTemperatureImpl(self: BrainModelHost, modelName = self.modelName): boolean {
  // Reasoning models reject an explicit temperature — see the shared
  // capability check (GPT-5, o-series, Opus 4.8+, Kimi K2.6+, DeepSeek
  // reasoner).
  return shouldSendTemperature(modelName);
}

export function generationOptionsImpl(
  self: BrainModelHost,
  maxOutputTokens: number,
  selection?: ModelSelection,
): Record<string, unknown> {
  const providerName = selection?.provider || self.provider;
  const modelName = resolveModelNameImpl(self, providerName, selection?.model || self.modelName);
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
    ...(shouldSendTemperatureImpl(self, modelName) ? { temperature: 0 } : {}),
    ...(isCliSpawning || omitsLegacyMaxTokens ? {} : { maxOutputTokens }),
    // forceReasoning routes the AI SDK to OpenAI's Responses API
    // (`/v1/responses`). Most third-party OpenAI-compatible proxies
    // (router.tangle.tools, LiteLLM, Together, vLLM, etc.) only implement
    // /v1/chat/completions — Responses API requests come back 503 / 4xx
    // and the SDK throws "Invalid JSON response". Disable on proxied
    // openai routes; only OpenAI direct supports the Responses API today.
    ...(providerName === 'openai'
      && /(^|\/)gpt-5(?:[.-]|$)/i.test(modelName)
      && !isProxiedOpenAIImpl(self, providerName)
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
export function isProxiedOpenAIImpl(self: BrainModelHost, providerName: string): boolean {
  return providerName === 'openai' && Boolean(self.baseUrl);
}

/** Get a LLM model instance, optionally with provider/model override (e.g. for CAPTCHA fallback) */
export async function getLanguageModelImpl(
  self: BrainModelHost,
  selection?: { provider?: 'openai' | 'anthropic' | 'google' | 'cli-bridge'; model?: string },
): Promise<LanguageModel> {
  return getModelImpl(self, selection)
}

/** Lazily create the LLM model instance based on provider config */
export async function getModelImpl(
  self: BrainModelHost,
  selection?: ModelSelection,
): Promise<LanguageModel> {
  const providerName = selection?.provider || self.provider;
  const modelName = resolveModelNameImpl(self, providerName, selection?.model || self.modelName);
  const apiKey = resolveProviderApiKey(providerName, self.explicitApiKey);
  const cacheKey = `${providerName}:${modelName}`;
  const cached = self.modelCache.get(cacheKey);
  if (cached) return cached;

  let model: LanguageModel;
  switch (providerName) {
    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      const provider = createAnthropic({
        apiKey,
        ...(self.baseUrl ? { baseURL: self.baseUrl } : {}),
      });
      model = provider(modelName) as LanguageModel;
      break;
    }
    case 'google': {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
      const provider = createGoogleGenerativeAI({
        apiKey,
        ...(self.baseUrl ? { baseURL: self.baseUrl } : {}),
      });
      model = provider(modelName) as LanguageModel;
      break;
    }
    case 'cli-bridge': {
      const { createOpenAI } = await import('@ai-sdk/openai');
      const rawUrl = self.baseUrl || process.env.CLI_BRIDGE_URL;
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
      const { codexExec } = await loadOptionalModule(
        () => import('ai-sdk-provider-codex-cli'),
        'ai-sdk-provider-codex-cli',
        "The 'codex-cli' provider",
      );
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
      const { createClaudeCode } = await loadOptionalModule(
        () => import('ai-sdk-provider-claude-code'),
        'ai-sdk-provider-claude-code',
        "The 'claude-code' provider",
      );
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
          ...(self.claudeCodeStreamingInput ? { streamingInput: 'always' as const } : {}),
          ...(self.debug ? { verbose: true } : {}),
          ...(self.debug
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
        const { createClaudeCode } = await loadOptionalModule(
          () => import('ai-sdk-provider-claude-code'),
          'ai-sdk-provider-claude-code',
          "The 'claude-code' provider",
        );
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
            ...(self.debug ? { verbose: true } : {}),
            ...(self.debug
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
      const usingProxy = isProxiedOpenAIImpl(self, providerName);
      const provider = createOpenAI({
        apiKey: apiKey || '',
        ...(self.baseUrl ? { baseURL: self.baseUrl } : {}),
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

  self.modelCache.set(cacheKey, model);
  return model;
}

export async function generateImpl(
  self: BrainModelHost,
  system: string | SystemModelMessage[],
  messages: ModelMessage[],
  selection?: ModelSelection,
  maxOutputTokens = 800,
): Promise<GenerateResult> {
  const providerName = selection?.provider || self.provider;
  const modelName = resolveModelNameImpl(self, providerName, selection?.model || self.modelName);

  // Sandbox backend doesn't accept structured system messages — flatten.
  const systemForSandbox = typeof system === 'string'
    ? system
    : system.map(m => m.content).join('\n\n');

  if (providerName === 'sandbox-backend') {
    const result = await generateWithSandboxBackend({
      system: systemForSandbox,
      messages,
      model: modelName,
      timeoutMs: self.llmTimeoutMs,
      debug: self.debug,
      backendType: self.sandboxBackendType,
      backendProfile: self.sandboxBackendProfile,
      backendModelProvider: self.sandboxBackendProvider,
    });
    return { text: result.text };
  }

  const model = await getModelImpl(self, {
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
    ...generationOptionsImpl(self, maxOutputTokens, { provider: providerName, model: modelName }),
    abortSignal: AbortSignal.timeout(self.llmTimeoutMs),
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
 * Generic text-completion entry point for non-agent uses (GEPA reflective
 * mutation, ad-hoc rubric authoring, knowledge distillation). Returns the
 * raw text + token usage; callers parse JSON themselves.
 *
 * No tool use, no decode-loop heuristics — just a single round-trip through
 * the configured provider/model.
 */
export async function completeImpl(
  self: BrainModelHost,
  system: string,
  user: string,
  options: { maxOutputTokens?: number } = {},
): Promise<{ text: string; tokensUsed?: number }> {
  const result = await generateImpl(
    self,
    system,
    [{ role: 'user', content: user }],
    undefined,
    options.maxOutputTokens ?? 1500,
  );
  return { text: result.text, tokensUsed: result.tokensUsed };
}

/**
 * Multimodal sibling of {@link completeImpl}: a single round-trip with a system
 * prompt, a user prompt, and one-or-more already-encoded images. The narrow
 * vision seam the reference-grounded taste judge binds to (one Brain per
 * `{ provider, model }` ref), built on the same `generate` so it goes through
 * the existing provider abstraction — any vision-capable backend works.
 *
 * Images arrive ENCODED (`{ image, mediaType }`, base64/data); the disk read +
 * mediaType inference live in the judge's `createBrainVisionModel` adapter, so
 * this method does no IO. It is NOT `auditDesign` — the page-audit seam stays
 * off-limits to taste comparison by contract.
 */
export async function completeVisionImpl(
  self: BrainModelHost,
  system: string,
  user: string,
  images: ReadonlyArray<{ image: string; mediaType: string }>,
  options: { maxOutputTokens?: number } = {},
): Promise<{ text: string; tokensUsed?: number }> {
  const content: UserContent = [
    { type: 'text' as const, text: user },
    ...images.map((img) => ({ type: 'image' as const, image: img.image, mediaType: img.mediaType })),
  ];
  const result = await generateImpl(
    self,
    system,
    [{ role: 'user', content }],
    undefined,
    options.maxOutputTokens ?? 1500,
  );
  return { text: result.text, tokensUsed: result.tokensUsed };
}
