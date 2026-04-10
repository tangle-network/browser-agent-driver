// Gen 13: vision-first observation mode.
// Screenshot is the primary input to Brain.decide. The LLM outputs
// coordinate-based actions (clickAt, typeAt) in 1024×768 virtual space.
// DOM snapshot is not sent (pure vision) or sent as compact supplement (hybrid).
//
// For WebVoyager validation: compare against planner-on-realweb.mjs baseline.
// Acceptance: curated-30 judge pass rate ≥70% (from 47% DOM-first).
export default {
  provider: 'openai',
  model: 'gpt-5.4',
  plannerEnabled: false, // vision-first uses per-action decide, not plan-then-execute
  vision: true,
  visionStrategy: 'always',
  observationMode: 'vision',
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
