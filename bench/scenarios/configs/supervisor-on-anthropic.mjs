export default {
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  supervisor: {
    enabled: true,
    minTurnsBeforeInvoke: 5,
    cooldownTurns: 3,
    maxInterventions: 2,
    hardStallWindow: 4,
  },
};
