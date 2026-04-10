// Gen 16: hybrid with DOM planner + vision fallback.
// Planner uses DOM-only (1 LLM call → N deterministic steps, ~2k tokens/turn).
// Per-action fallback uses unified vision+DOM (screenshot + refs, ~10k tokens/turn).
// This is the "best of both worlds" — DOM speed for easy steps, vision accuracy
// when the planner stalls or deviates.
//
// Gen 15 baseline: 73.7% on full WebVoyager (590 tasks). 55% of failures were
// cost_cap_exceeded because vision per-action loop burned ~10k tokens/turn.
// The planner cuts token usage 3-5× on navigation/form-fill steps.
export default {
  provider: 'openai',
  model: 'gpt-5.4',
  plannerEnabled: true,
  vision: true,
  visionStrategy: 'always',
  observationMode: 'hybrid',
  initialObserveSettleMs: 3000,
  supervisor: {
    enabled: true,
    useVision: true,
    minTurnsBeforeInvoke: 3,
    cooldownTurns: 2,
    maxInterventions: 4,
    hardStallWindow: 6,
  },
};
