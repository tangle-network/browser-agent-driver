---
"@tangle-network/browser-agent-driver": patch
---

Bump patchright 1.58.2 → 1.60.2 to align the bundled Chromium revision with the sandbox build cache.

patchright 1.58.2 pinned chromium-headless-shell revision **1208**, but the sidecar runtime's shared `tangle-npm-cache` now carries revision **1223** (downloaded by a newer patchright). The driver launched its own 1208 patchright, which wasn't in the cache, so the browser failed at launch:

```
browserType.launch: Executable doesn't exist at .../chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell
```

patchright 1.60.2 pins revision **1223**, which is present in the cache, so the browser launches. No driver code changes — typecheck and the browser-launch suite pass unchanged.
