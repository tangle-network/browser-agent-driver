# Providers

Default provider is `openai` with `gpt-5.4`.

## OpenAI (default)

```bash
export OPENAI_API_KEY=sk-...
agent-driver run --goal "..." --url https://...
```

Custom endpoint (LiteLLM, Azure, etc.):

```bash
agent-driver run --goal "..." --url https://... --base-url http://localhost:4000/v1
```

## Anthropic

```bash
export ANTHROPIC_API_KEY=sk-ant-...
agent-driver run --goal "..." --url https://... --provider anthropic --model claude-sonnet-4-6
```

## Codex CLI

Uses AI SDK v6 via [`ai-sdk-provider-codex-cli`](https://github.com/ben-vargas/ai-sdk-provider-codex-cli). Runs the local `codex` binary instead of making HTTP calls.

```bash
codex login
agent-driver run --goal "..." --url https://... --provider codex-cli --model gpt-5
```

- Uses `codex login` auth or `OPENAI_API_KEY` fallback.
- `CODEX_CLI_PATH` overrides the binary path.
- `CODEX_ALLOW_NPX=0` disables npx fallback.

## Claude Code

Uses the local `claude` CLI via `ai-sdk-provider-claude-code`. Useful for subscription/OAuth auth.

```bash
claude login
agent-driver run --goal "..." --url https://... --provider claude-code
```

- Uses `claude login` auth or `ANTHROPIC_API_KEY` fallback.
- `CLAUDE_CODE_CLI_PATH` overrides the binary path.
- Defaults to `sonnet` if no model specified.

## Sandbox Backend

Native sidecar-runtime path for `agent-dev-container` environments.

```bash
agent-driver run --goal "..." --url https://... \
  --provider sandbox-backend \
  --sandbox-backend-type claude-code \
  --model sonnet
```

- Expects local sidecar API at `http://127.0.0.1:$SIDECAR_PORT`.
- Auth via `SIDECAR_AUTH_TOKEN` / `SANDBOX_SIDECAR_AUTH_TOKEN`.
- Use `--sandbox-backend-type codex` or `claude-code` to compare backends.
