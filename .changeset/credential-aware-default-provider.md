---
'@tangle-network/browser-agent-driver': minor
---

The default provider is now credential-aware instead of a hard `openai`. A bare run (no `--provider`/`--model`, no config-file provider) uses OpenAI when `OPENAI_API_KEY` is set — unchanged for existing users and CI — and otherwise falls back to an available provider (claude-code, which needs no key) rather than failing on a missing OpenAI key. An explicit provider in CLI flags or a config file is always honored, and the default model maps per-provider as before (e.g. gpt-5.4 → sonnet for claude-code). This removes the last place the no-flag path assumed OpenAI; the engine already supported openai/anthropic/google/claude-code/zai for both text and vision.
