export default {
  provider: 'openai',
  model: 'gpt-5.2',
  supervisor: {
    enabled: true,
    minTurnsBeforeInvoke: 3,
    cooldownTurns: 2,
    maxInterventions: 4,
    hardStallWindow: 3,
  },
};
