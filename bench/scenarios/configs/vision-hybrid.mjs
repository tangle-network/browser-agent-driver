// Gen 22: model cascade — gpt-5.4 for planning, gpt-4.1-mini for execution.
// The planner needs vision + reasoning (expensive). The per-action executor
// just follows instructions (cheap). 9× cheaper output tokens on execution.
//
// Gen 20 baseline: ~92% on failure rerun. Cost: $0.20/task.
// Gen 22 target: same accuracy, ~$0.06/task.
export default {
  provider: 'openai',
  model: 'gpt-5.4',
  adaptiveModelRouting: true,
  navModel: 'gpt-4.1-mini',
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
