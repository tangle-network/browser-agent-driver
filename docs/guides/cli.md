# CLI Reference

## Basic Usage

```bash
# single task
agent-driver run --goal "Sign up for account" --url http://localhost:3000

# test suite
agent-driver run --cases ./cases.json

# with config file
agent-driver run --config ./ci.config.ts --cases ./cases.json

# override model/concurrency
agent-driver run --cases ./cases.json --model gpt-5.4 --concurrency 4
```

## Authenticated Sessions

Save a browser session once, reuse across runs:

```bash
pnpm auth:save-state
pnpm auth:check-state ./.auth/session.json example.com
```

```bash
agent-driver run --goal "Open settings" \
  --url https://app.example.com \
  --storage-state ./.auth/session.json
```

## Run Modes

| Mode | Vision | Screenshots | Blocking | Use case |
|------|--------|-------------|----------|----------|
| `fast-explore` | off | off | analytics | Speed / iteration |
| `full-evidence` | on | every 3 turns | — | Release signoff |

Mode presets apply defaults; explicit CLI flags override.

```bash
agent-driver run --cases ./cases.json --mode fast-explore
agent-driver run --cases ./cases.json --mode full-evidence
```

## Execution Profiles

| Profile | Description |
|---------|-------------|
| `default` | Balanced defaults |
| `stealth` | Headed + anti-detection args |
| `webbench` | Speed benchmark (vision off, heavy blocking) |
| `webbench-stealth` | Reach benchmark (stealth args, analytics-only blocking) |
| `webvoyager` | Evidence benchmark (vision on) |

Profiles are orthogonal to modes. Use both:

```bash
agent-driver run --cases ./cases.json --profile webbench-stealth --mode fast-explore
```

## Adaptive Model Routing

Route verification to a cheaper model:

```bash
agent-driver run \
  --model gpt-5.4 \
  --model-adaptive \
  --nav-model gpt-4.1-mini \
  --cases ./cases.json
```

## Trajectory Memory

Reuse successful run trajectories:

```bash
agent-driver run --cases ./cases.json --memory --memory-dir ./.agent-memory
```

With trace scoring:

```bash
agent-driver run --cases ./cases.json \
  --memory --trace-scoring --trace-ttl-days 30
```

## Personas

```bash
# auto-generated from goal + URL
agent-driver run --goal "..." --url https://... --persona auto

# named persona
agent-driver run --goal "..." --url https://... --persona alice-blueprint-builder
```

## CI Checks

```bash
pnpm lint
pnpm check:boundaries
pnpm test
```
