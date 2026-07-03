---
"@tangle-network/browser-agent-driver": patch
---

Gracefully degrade video recording when Playwright/patchright's ffmpeg binary is unavailable. Previously a runtime whose browser cache ships Chromium but not ffmpeg (e.g. the Tangle sandbox's agent-thin image) crashed the whole run at `context.newPage()` with "Executable doesn't exist at .../ffmpeg-<rev>/ffmpeg-linux". The driver now probes the Playwright browsers cache for ffmpeg and, when it's absent, drops `recordVideo` and continues — report, screenshots, and trace are still captured; only the replay video is skipped. Detection biases toward keeping recording on (it only disables when the browsers directory positively exists without ffmpeg), so normal dev/CI is unchanged. The same guard is applied to `bad showcase --formats webm`, which shares the identical `recordVideo` failure mode.
