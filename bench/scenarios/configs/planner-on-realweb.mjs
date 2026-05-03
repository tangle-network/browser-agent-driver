// Planner config for public-web tasks.
export default {
  provider: 'openai',
  model: 'gpt-5.4',
  plannerEnabled: true,
  // Use the planner for workflow/form tasks; route extraction-shaped tasks
  // through the per-action observe-act loop.
  plannerMode: 'auto',
  // Wait for dynamic page content before the planner observes the page.
  initialObserveSettleMs: 3000,
  supervisor: {
    enabled: true,
    minTurnsBeforeInvoke: 3,
    cooldownTurns: 2,
    maxInterventions: 4,
    hardStallWindow: 6,
  },
};
