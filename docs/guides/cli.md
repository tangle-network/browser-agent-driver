# CLI Reference

## Basic Usage

```bash
# single task
bad run --goal "Sign up for account" --url http://localhost:3000

# test suite
bad run --cases ./cases.json

# with config file
bad run --config ./ci.config.ts --cases ./cases.json

# override model/concurrency
bad run --cases ./cases.json --model gpt-5.4 --concurrency 4
```

## Authenticated Sessions

Save a browser session once, reuse across runs:

```bash
pnpm auth:save-state
pnpm auth:check-state ./.auth/session.json example.com
```

```bash
bad run --goal "Open settings" \
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
bad run --cases ./cases.json --mode fast-explore
bad run --cases ./cases.json --mode full-evidence
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
bad run --cases ./cases.json --profile webbench-stealth --mode fast-explore
```

## Adaptive Model Routing

Route verification to a cheaper model:

```bash
bad run \
  --model gpt-5.4 \
  --model-adaptive \
  --nav-model gpt-4.1-mini \
  --cases ./cases.json
```

## Trajectory Memory

Memory is enabled by default. Successful run trajectories are stored in `.agent-memory/` and reused on subsequent runs to reduce turns and improve reliability.

```bash
# disable memory for a clean run
bad run --cases ./cases.json --no-memory

# custom memory directory
bad run --cases ./cases.json --memory-dir ./.my-memory

# with trace scoring
bad run --cases ./cases.json --trace-scoring --trace-ttl-days 30
```

## Personas

```bash
# auto-generated from goal + URL
bad run --goal "..." --url https://... --persona auto

# named persona
bad run --goal "..." --url https://... --persona alice-blueprint-builder
```

## CI Checks

```bash
pnpm lint
pnpm check:boundaries
pnpm test
```
