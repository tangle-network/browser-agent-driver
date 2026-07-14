---
"@tangle-network/browser-agent-driver": minor
---

fix(observe): bound the CDP observe path so a wedged renderer can't hang a run

A raw `CDPSession.send()` carries no Playwright timeout. Behind a managed-egress
proxy on `about:blank`, `Accessibility.getFullAXTree` / `Runtime.evaluate` could
never return, and turn-1 `observe()` had no outer deadline — so a run wedged there
for the whole case budget instead of failing or recovering.

`observe()` now bounds each CDP call (`newCDPSession`, `Runtime.evaluate`,
`Accessibility.getFullAXTree`) and degrades on timeout: CDP → the Playwright
`ariaSnapshot` fallback → a minimal URL-only state, so the run always advances
rather than stalling. A single shared per-observe budget wraps the whole attempt,
so the individual step ceilings can't sum past it (covering the screenshot and
SoM steps in vision mode too). Each timeout logs which step wedged, which
localizes the wedge from production logs.

Adds two optional `PlaywrightDriverOptions` to tune the ceilings per environment:
`cdpObserveTimeoutMs` (per-CDP-call ceiling, default 8000) and `observeBudgetMs`
(total per-observe budget, default 20000).
