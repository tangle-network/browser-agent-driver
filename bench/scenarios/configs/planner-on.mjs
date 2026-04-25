// Gen 7: enable plan-then-execute. The runner makes one Brain.plan() LLM
// call up front and executes the plan deterministically, falling back to
// the per-action loop on the first verification failure.
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
