---
"@tangle-network/browser-agent-driver": patch
---

Move the CLI-backed provider adapters (`ai-sdk-provider-codex-cli`, `ai-sdk-provider-claude-code`) and `ffmpeg-static` to `optionalDependencies`. Consumers that only drive `--provider openai` — e.g. slim sandbox runtime images — can now install with `npm install --omit=optional` to skip ~300 MB of platform-native binaries (the bundled Codex CLI, the Claude Agent SDK's per-platform ripgrep, and the static ffmpeg). Default installs are unchanged: optional dependencies still install by default, so the full provider/showcase surface works out of the box. When an omitted dependency's provider is selected (including the keyless `claude-code` default) or `bad showcase` is run without it, the driver now throws an actionable "reinstall without --omit=optional" error instead of a raw `ERR_MODULE_NOT_FOUND`.
