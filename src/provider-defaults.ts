export type SupportedProvider =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'codex-cli'
  | 'claude-code'
  | 'sandbox-backend'
  | 'zai-coding-plan';

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
    case 'codex-cli':
    case 'openai':
    default:
      return env.OPENAI_API_KEY;
  }
}
