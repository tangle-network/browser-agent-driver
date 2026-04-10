# Pursuit: Vision-first observation mode — Gen 13
Generation: 13
Date: 2026-04-09
Status: built, awaiting validation
Branch: main

## Thesis

The 31pp gap to Magnitude (47% → 94% judge-confirmed on WebVoyager) is **architectural**, not tunable. Magnitude uses vision-first: screenshot as the sole observation for action planning, with the LLM outputting pixel coordinates. bad uses DOM-first: ARIA snapshot as the primary observation, with ref-based selectors.

Vision-first sees what humans see. DOM-first sees what the accessibility tree exposes — which misses:
- Visual layout, spatial relationships
- Images, icons, visual affordances
- Dynamic content rendered via canvas or complex CSS
- Content the ARIA tree truncates or misses

Gen 13 ships the vision-first observation mode as an opt-in config. The planner stays DOM-first for deterministic tasks; vision-first is for the per-action loop on open-web tasks.

## What was built

### New action types (types.ts)
- `clickAt({x, y})` — click at pixel coordinates in 1024×768 virtual screen space
- `typeAt({x, y, text})` — click at coordinates then type text

### Driver changes (drivers/playwright.ts)
- Virtual screen constant: `VIRTUAL_SCREEN = {width: 1024, height: 768}`
- `clickAt` handler: maps virtual coordinates to actual viewport via `x * (viewport.width / 1024)`
- `typeAt` handler: click + wait 100ms + keyboard.type

### Brain changes (brain/index.ts)
- `VISION_FIRST_PROMPT`: new system prompt for coordinate-based actions
- `observationMode` property: 'dom' | 'vision' | 'hybrid'
- `decideVision()` method: screenshot-primary observation, minimal DOM context
  - Pure vision: screenshot + URL/title only
  - Hybrid: screenshot + 4k compact DOM snapshot

### Config changes
- `observationMode?: 'dom' | 'vision' | 'hybrid'` in DriverConfig and AgentConfig
- `--observation-mode` CLI flag
- Vision mode auto-enables: `vision: true`, `visionStrategy: 'always'`, `screenshotInterval: 1`

### Parser + policy updates
- `clickAt` and `typeAt` in valid actions set
- `validateAction()` handles both new types
- Supervisor policy generates action signatures for stall detection

### Benchmark configs
- `bench/scenarios/configs/vision-first.mjs` — pure vision, gpt-5.4
- `bench/scenarios/configs/vision-hybrid.mjs` — vision + compact DOM

### Screenshot persistence fix (Action 3)
- CLI mode presets no longer clobber profile-set vision/screenshotInterval
- WebVoyager runner defaults to `webvoyager` profile (vision enabled)
- Evaluator manifest path resolution fixed (uses entry.uri/entry.name, not entry.path)

## Acceptance criteria

WebVoyager curated-30 judge pass rate ≥70% (from 47%).

## Validation plan

1. Run curated-30 with `--config bench/scenarios/configs/vision-first.mjs` (pure vision)
2. Run curated-30 with `--config bench/scenarios/configs/vision-hybrid.mjs` (hybrid)
3. Run curated-30 with baseline `--config bench/scenarios/configs/planner-on-realweb.mjs` (DOM-first, same-day)
4. Compare judge pass rates across all three
5. Per CLAUDE.md rules: ≥5 reps for quality claims, same-day baselines

## Risks

- **Per-action latency increase**: image tokens add ~100ms per LLM call
- **Cost increase**: image tokens are 5-10x more expensive per token than text
- **Coordinate accuracy**: depends on model's vision capability; may need virtual screen viewport
- **Viewport mismatch**: current default 1920×1080, but coordinates are 1024×768 virtual space. Linear mapping should work but hasn't been validated.
- **Model compatibility**: vision-first prompt is optimized for gpt-5.4. May need adjustment for Claude models.

## Next steps

1. Validate with WebVoyager curated-30 (≥3 reps each config)
2. If coordinate accuracy is low, consider setting actual viewport to 1024×768
3. Consider adding SoM (Set-of-Marks) overlay — annotate interactive elements with numbered labels on the screenshot for better element targeting
4. If hybrid mode outperforms pure vision, make hybrid the default for open-web
