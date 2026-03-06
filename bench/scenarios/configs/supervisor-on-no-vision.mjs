export default {
  provider: 'openai',
  model: 'gpt-5.2',
  supervisor: {
    enabled: true,
    useVision: false,
    minTurnsBeforeInvoke: 5,
    cooldownTurns: 3,
    maxInterventions: 2,
    hardStallWindow: 4,
  },
};
