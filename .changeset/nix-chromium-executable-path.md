---
"@tangle-network/browser-agent-driver": minor
---

Add `executablePath` support (via the `executablePath` config field or the `BAD_CHROMIUM_EXECUTABLE_PATH` env var) to launch a specific Chromium binary instead of the Playwright-managed browser. When set, launch sites pass `executablePath` and omit `channel`.

This lets a sandbox runtime point the driver at a host-provided Chromium (e.g. the Nix profile's `/nix/profile/bin/chromium`) rather than requiring Playwright's bundled browser and its system libraries to be baked into the container image. Opt-in and Chromium-only; when unset, launch behavior is unchanged.
