export type SupportedProvider =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'cli-bridge'
  | 'codex-cli'
  | 'claude-code'
  | 'sandbox-backend'
  | 'zai-coding-plan';

/** Runtime list of the `SupportedProvider` union — the single source of truth
 *  for validating a user-supplied `--provider` string before it is cast. */
export const SUPPORTED_PROVIDERS: readonly SupportedProvider[] = [
  'openai',
  'anthropic',
  'google',
  'cli-bridge',
  'codex-cli',
  'claude-code',
  'sandbox-backend',
  'zai-coding-plan',
];

/** Narrow an arbitrary string to a `SupportedProvider`. */
export function isSupportedProvider(value: string): value is SupportedProvider {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Z.ai coding plan endpoints. The plan exposes two compatibility surfaces:
 *   - OpenAI-compatible at /api/coding/paas/v4 — works with glm-4.6 / glm-4.5
 *     via the OpenAI SDK (createOpenAI + custom baseURL)
 *   - Anthropic-compatible at /api/anthropic — works with the Anthropic SDK
 *     and with the Claude Code CLI when ANTHROPIC_BASE_URL/AUTH_TOKEN are set
 *
 * Exported as constants so the brain switch and the claude-code routing
 * env-var setup share one source of truth.
 */
export const ZAI_OPENAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4';
export const ZAI_ANTHROPIC_BASE_URL = 'https://api.z.ai/api/anthropic';

/**
 * When true, the model name routes through Claude Code CLI with the Z.ai
 * Anthropic-compatible endpoint. Used by the brain to decide which backend
 * to spin up under `zai-coding-plan`.
 */
export function isClaudeCodeRoutedModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  return m === 'claude-code' || m === 'cc' || m.startsWith('claude-');
}

export function resolveProviderModelName(
  provider: SupportedProvider,
  requestedModel?: string,
  options?: {
    sandboxBackendType?: string;
  },
): string {
  const model = requestedModel?.trim();

  if (provider === 'claude-code') {
    if (!model || /^gpt-5(?:[.-]|$)/i.test(model)) {
      return 'sonnet';
    }
  }

  if (provider === 'zai-coding-plan') {
    // Default to glm-5.1 (Z.ai's current flagship coding model). If the user
    // passes 'claude-code' or any 'claude-*' alias, the brain routes through
    // the Claude Code CLI subprocess with Z.ai env-var overrides instead.
    if (!model || /^gpt-5(?:[.-]|$)/i.test(model)) {
      return 'glm-5.1';
    }
  }

  if (provider === 'cli-bridge') {
    const harness = process.env.CLI_BRIDGE_DEFAULT_HARNESS?.trim() || 'codex';
    if (!model) return `${harness}/gpt-5.5`;
    return model.includes('/') ? model : `${harness}/${model}`;
  }

  if (provider === 'sandbox-backend') {
    const backendType = (options?.sandboxBackendType || process.env.SANDBOX_BACKEND_TYPE || '').trim().toLowerCase();
    if (backendType === 'claude-code') {
      if (!model || /^gpt-5(?:[.-]|$)/i.test(model)) {
        return 'sonnet';
      }
    }
    if (backendType === 'codex') {
      if (!model) {
        return 'gpt-5';
      }
    }
  }

  return model || 'gpt-5.4';
}

/**
 * Pick a default provider when the CLI passed none. Honours a present
 * `OPENAI_API_KEY` (→ `'openai'`, which resolves to `gpt-5.4` + the OpenAI key)
 * before falling back to the keyless `'claude-code'` engine. Mirrors the `run`
 * command's `driverConfig.provider || 'openai'` precedent so design-audit no
 * longer silently overrides a present OpenAI key with claude-code/sonnet.
 *
 * Fail-open offline: with no `OPENAI_API_KEY` the result is still
 * `'claude-code'`, preserving the zero-key path the engine was designed to run
 * on. Only the design-audit default site consumes this; explicit `--provider`
 * still wins, so no other command's behaviour changes.
 */
export function resolveDefaultProvider(env: NodeJS.ProcessEnv = process.env): SupportedProvider {
  if (env.OPENAI_API_KEY) return 'openai';
  return 'claude-code';
}

export function resolveProviderApiKey(
  provider: SupportedProvider,
  explicitApiKey?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (explicitApiKey) return explicitApiKey;

  switch (provider) {
    case 'anthropic':
    case 'claude-code':
      return env.ANTHROPIC_API_KEY;
    case 'sandbox-backend':
      return undefined;
    case 'google':
      return env.GOOGLE_GENERATIVE_AI_API_KEY || env.GEMINI_API_KEY;
    case 'zai-coding-plan':
      // Prefer Z.ai-specific keys, then fall back to ANTHROPIC_AUTH_TOKEN
      // (which is what Claude Code uses when redirected at Z.ai), then
      // ANTHROPIC_API_KEY for the truly lazy path.
      return env.ZAI_API_KEY || env.ZAI_CODING_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY;
    case 'cli-bridge':
      return env.CLI_BRIDGE_BEARER || env.BRIDGE_BEARER;
    case 'codex-cli':
    case 'openai':
    default:
      return env.OPENAI_API_KEY;
  }
}

/**
 * Whether an explicit `temperature` may be sent to a model.
 *
 * Reasoning / thinking models fix temperature internally and REJECT an explicit
 * value — passing one errors (Anthropic: "temperature is deprecated for this
 * model"; Moonshot: "only 1 is allowed for this model"; OpenAI o-series/GPT-5:
 * unsupported_value). Return false for those so callers OMIT the param;
 * everything else still gets the deterministic `temperature: 0`.
 *
 * Matched by family (with an optional `provider/` prefix) so dated snapshots
 * like `claude-opus-4-8-20250805` are covered. Non-reasoning siblings that DO
 * accept temperature (claude-opus-4-1, deepseek-v4/chat, gpt-4o, sonnet, kimi-k2)
 * are intentionally not matched, so their behavior is unchanged.
 */
const TEMPERATURE_UNSUPPORTED: RegExp[] = [
  /(^|\/)gpt-5(?:[.-]|$)/i, // OpenAI GPT-5 family
  /(^|\/)o[1-9](?:[.-]|$)/i, // OpenAI o-series reasoning (o1, o3, o4…)
  /claude-opus-4-(?:[89]|\d{2,})/i, // Claude Opus 4.8+ (temperature deprecated)
  /kimi-(?:k2\.(?:[6-9]|\d{2,})|thinking)/i, // Moonshot Kimi K2.6+ / thinking
  /deepseek-(?:reasoner|r\d)/i, // DeepSeek reasoning (deepseek-reasoner, r1)
];

export function shouldSendTemperature(modelName: string): boolean {
  return !TEMPERATURE_UNSUPPORTED.some((re) => re.test(modelName));
}
