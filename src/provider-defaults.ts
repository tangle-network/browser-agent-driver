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
