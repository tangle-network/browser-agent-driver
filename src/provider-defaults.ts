export type SupportedProvider =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'codex-cli'
  | 'claude-code';

export function resolveProviderModelName(
  provider: SupportedProvider,
  requestedModel?: string,
): string {
  const model = requestedModel?.trim();

  if (provider === 'claude-code') {
    if (!model || /^gpt-5(?:[.-]|$)/i.test(model)) {
      return 'sonnet';
    }
  }

  return model || 'gpt-5.2';
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
    case 'google':
      return env.GOOGLE_GENERATIVE_AI_API_KEY || env.GEMINI_API_KEY;
    case 'codex-cli':
    case 'openai':
    default:
      return env.OPENAI_API_KEY;
  }
}
