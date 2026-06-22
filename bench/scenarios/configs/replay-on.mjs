// Treatment arm: zero-LLM replay of warm-store trajectories. The harness REQUIRES
// --memory --memory-isolation shared --concurrency 1 with a replay-on arm (the
// off arm must record before the on arm replays); run-ab-experiment guards this.
export default {
  replay: { enabled: true },
};
