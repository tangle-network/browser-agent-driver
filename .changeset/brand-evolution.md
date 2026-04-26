---
'@tangle-network/browser-agent-driver': minor
---

feat(jobs+reports): brand-kit / design-system extraction at every audit target

Comparative-audit jobs can now extract the full deterministic design-token bundle (colors, font families, type scale, logos, font files, brand metadata, detected libraries) at every target — including every wayback snapshot. New `brand-evolution` report template renders a per-URL chronological view of palette and typography drift, with snapshot-to-snapshot deltas (colors added/removed, font family swaps, brand-meta changes, library adoption).

**Spec:** add `audit.extractTokens: true` to a `JobSpec`. Each per-target output dir gets a `tokens.json` alongside `report.json`.

**CLI:** `bad reports generate --template brand-evolution --job <id>`

**AI SDK tools:** two new tools — `fetchTokens` (returns the per-target token summaries, optionally filtered to one URL's chronological series) and `diffTokens` (deterministic delta between two token summaries in the same job). `renderTemplate` now accepts `template: 'brand-evolution'`.

The token extractor is the existing `extractDesignTokens` (no LLM, ~10s per target). Same deterministic-data / LLM-narrates contract as the rest of the reports surface — every callout in the brand-evolution report comes from a pure function of `tokens.json`.

Verified end-to-end on `https://stripe.com/` 2014 → 2019 → 2024 wayback snapshots: pulled out the Whitney → Camphor → sohne-var typeface progression and the matching primary-color shifts (`#008cdd` → `#6772e5` → `#635bff`).

+12 new tests across `reports-tokens` and the queue/tools touch-ups. Total: 1460 passing.
