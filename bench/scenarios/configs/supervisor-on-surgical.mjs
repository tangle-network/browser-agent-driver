export default {
  provider: 'openai',
  model: 'gpt-5.2',
  supervisor: {
    enabled: true,
    minTurnsBeforeInvoke: 2,
    cooldownTurns: 1,
    maxInterventions: 2,
    hardStallWindow: 2,
  },
};
