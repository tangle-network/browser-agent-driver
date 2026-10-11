---
"@tangle-network/browser-agent-driver": patch
---

Remove the `type` action's pre-fill click. `fill()` focuses the element itself; the click hung to the full 30s actionability timeout on inputs with an obstructed hit target (e.g. date inputs with a picker trigger) even though the fill succeeded instantly. Pointer-intercept failures now fall back to `fill({ force: true })`.
