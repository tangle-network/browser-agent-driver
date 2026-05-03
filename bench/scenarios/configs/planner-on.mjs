// Enable plan-then-execute with per-action fallback on verification failure.
export default {
  provider: 'openai',
  model: 'gpt-5.2',
  plannerEnabled: true,
  supervisor: {
    enabled: true,
    minTurnsBeforeInvoke: 5,
    cooldownTurns: 3,
    maxInterventions: 2,
    hardStallWindow: 4,
  },
};
