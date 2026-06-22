// Treatment arm for the warm-replay A/B: zero-LLM replay of warm-store
// trajectories. Pair with --memory-isolation shared so the off arm's recorded
// trajectories are available to replay.
export default {
  provider: 'claude-code',
  replay: { enabled: true },
};
