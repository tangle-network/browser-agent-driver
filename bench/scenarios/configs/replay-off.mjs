// Control arm for the warm-replay A/B (run-ab-experiment.mjs). Pure: only the
// replay flag — provider/model come from --provider/--model on the harness, so
// this works for any provider (claude-code, openai/gpt-5.4 for the promotion gate).
export default {
  replay: { enabled: false },
};
