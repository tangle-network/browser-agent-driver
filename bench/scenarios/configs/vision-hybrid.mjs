// Gen 13: hybrid observation mode — screenshot primary + compact DOM supplement.
// Both coordinate actions (clickAt/typeAt) and ref-based actions (click/type) available.
export default {
  provider: 'openai',
  model: 'gpt-5.4',
  plannerEnabled: false,
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
