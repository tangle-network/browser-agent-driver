# Published dependency ownership sweep

Verified against main a94de62a034eaf62ddad2cf8fca21a7547bdf5b7.

## Result

The earlier finding that `src/brain/model-client.ts` is simply a hand-wrapped agent-runtime copy is not correct.

The Brain client owns product behavior beyond Runtime's current router profile client: Anthropic, Google, Groq/Z.ai/OpenAI-compatible routing, Claude Code and Codex CLI providers, proxy-specific non-streaming behavior, prompt-cache accounting, and the Browser Agent Driver's model selection contract. The published Runtime `profileChatClient` owns an exact AgentProfile + Runtime Executor call. It does not replace these non-Runtime provider modes without changing BAD's public behavior.

The repo already uses published Tangle packages in development/signoff: agent-app, agent-eval, and agent-integrations are registry dependencies. There is no vendored copy of those packages in the checked paths.

## Exact GTR proof

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build

export TANGLE_ROUTER_API_KEY='<real router key>'
node scripts/run-mode-baseline.mjs \
  --base-url https://router.tangle.tools/v1 \
  --api-key "$TANGLE_ROUTER_API_KEY" \
  --model gpt-5.4
```

Retain the install output, successful build, and the baseline's real Router request/response evidence. The request must reach `/v1/chat/completions` on the configured Router and produce a non-fixture model response.

Do not collapse `model-client.ts` into Runtime until BAD chooses AgentProfile/Runtime Executor as the owner of all model execution or narrows its provider surface.