// Control arm for the warm-replay A/B (run-ab-experiment.mjs).
// Provider is set here because the harness sources provider from the arm config
// (model comes from --model). Override with --off-config for other providers.
export default {
  provider: 'claude-code',
  replay: { enabled: false },
};
