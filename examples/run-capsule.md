# Session viewer and shareable run videos

## View a run locally

Every run writes a self-contained directory (`report.json` + per-turn
screenshots + action JSON + reasoning). Open it in the web UI:

```bash
bad view audit-results/stripe.com-1775502457141
```

Pair with `--show-cursor` at run time for an animated cursor overlay in the
screenshots.

## Render a run to video with run-capsule

`report.json` is a complete trace — per-turn screenshot, action, reasoning —
so it renders directly into a shareable video via
[`run-capsule`](https://github.com/tangle-network/run-capsule), no extra
capture step:

```bash
npx run-capsule --playwright agent-results/report.json --no-upload
# → screen.mp4  (product frames, each captioned with the agent's reasoning + action + URL)
# → replay.mp4  (the unified storyboard)
```

For the **animated cursor**, run with `--show-cursor` (bakes cursor +
reasoning overlay into the run's own `recording.webm`) and hand that recording
to run-capsule as the screen capsule — it is reused as-is rather than rebuilt:

```bash
bad run --goal "…" --url https://… --show-cursor
npx run-capsule --playwright agent-results/report.json \
  --video agent-results/cli-task/recording.webm --no-upload
```

Notes:

- Without `--video`, the `screen` capsule replays the per-turn screenshots —
  real frames only when the run captured them (vision is on by default unless
  you pass `--no-vision` or a vision-off profile, which blocks images).
- Drop `--no-upload` for a temporary public link.
