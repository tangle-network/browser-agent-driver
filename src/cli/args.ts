import { parseArgs } from 'node:util';

/**
 * Parse the top-level `bad` CLI flags. The option set is shared across every
 * command; individual command handlers read the subset they need. Kept in one
 * place so the strict parser and the `--help` output stay in lockstep.
 *
 * Defaults to `process.argv.slice(2)` exactly like the bare `parseArgs` call it
 * replaced — subcommand groups (jobs/reports) dispatch before this runs.
 */
export function parseCliArgs() {
  return parseArgs({
    allowPositionals: true,
    allowNegative: true,
    options: {
      // Config file
      config: { type: 'string' },

      // Test specification
      goal: { type: 'string', short: 'g' },
      url: { type: 'string', short: 'u' },
      cases: { type: 'string', short: 'c' },
      'cases-json': { type: 'string' },
      'allowed-domains': { type: 'string' },

      // LLM configuration
      model: { type: 'string', short: 'm' },
      provider: { type: 'string' },
      'model-adaptive': { type: 'boolean' },
      'nav-model': { type: 'string' },
      'nav-provider': { type: 'string' },
      persona: { type: 'string' },
      mode: { type: 'string' },
      profile: { type: 'string' },
      'prompt-file': { type: 'string' },
      'sandbox-backend-type': { type: 'string' },
      'sandbox-backend-profile': { type: 'string' },
      'sandbox-backend-provider': { type: 'string' },
      'api-key': { type: 'string' },
      'base-url': { type: 'string' },

      // Execution
      browser: { type: 'string' },
      'storage-state': { type: 'string' },
      concurrency: { type: 'string' },
      'max-turns': { type: 'string' },
      'session-id': { type: 'string' },
      'resume-run': { type: 'string' },
      'fork-run': { type: 'string' },
      pages: { type: 'string' },
      'extract-tokens': { type: 'boolean' },
      rip: { type: 'boolean' },
      'design-compare': { type: 'boolean' },
      'compare-url': { type: 'string' },
      evolve: { type: 'string' },
      'evolve-rounds': { type: 'string' },
      'project-dir': { type: 'string' },
      reproducibility: { type: 'boolean' },
      'rubrics-dir': { type: 'string' },
      'audit-passes': { type: 'string' },
      // design-audit reference-grounded eval (opt-in; default v1)
      reference: { type: 'string' },
      'reference-grounded': { type: 'boolean' },
      // reference-grounded taste judge: text (default) | vision, + ensemble list
      judge: { type: 'string' },
      'judge-models': { type: 'string' },
      // Layer 7 — domain ethics gate. --skip-ethics bypasses the rollup floor
      // for testing scenarios; --ethics-rules-dir overrides the builtin rule set.
      'skip-ethics': { type: 'boolean' },
      'ethics-rules-dir': { type: 'string' },
      // Layer 6 / 7 — audience predicate hints. Comma-separated.
      audience: { type: 'string' },
      'regulatory-context': { type: 'string' },
      'audience-vulnerability': { type: 'string' },
      modality: { type: 'string' },
      // bad view
      port: { type: 'string' },
      'no-open': { type: 'boolean' },
      // bad run --show-cursor (overlay)
      'show-cursor': { type: 'boolean' },
      // bad run --live (open SSE-streaming live viewer alongside the run)
      live: { type: 'boolean' },
      // bad run --planner: one LLM call generates the full action sequence,
      // then the runner executes it deterministically.
      planner: { type: 'boolean' },
      'planner-mode': { type: 'string' },
      // showcase
      script: { type: 'string' },
      capture: { type: 'string' },
      crop: { type: 'string' },
      highlight: { type: 'string' },
      format: { type: 'string' },
      viewport: { type: 'string' },
      scale: { type: 'string' },
      'color-scheme': { type: 'string' },
      'llm-timeout': { type: 'string' },
      retries: { type: 'string' },
      'retry-delay-ms': { type: 'string' },
      'screenshot-interval': { type: 'string' },
      scout: { type: 'boolean' },
      'scout-model': { type: 'string' },
      'scout-provider': { type: 'string' },
      'scout-vision': { type: 'boolean' },
      'scout-max-candidates': { type: 'string' },
      'scout-min-top-score': { type: 'string' },
      'scout-max-score-gap': { type: 'string' },
      headless: { type: 'boolean' },
      proxy: { type: 'string' },
      timeout: { type: 'string' },
      extension: { type: 'string', multiple: true },
      'user-data-dir': { type: 'string' },
      'profile-dir': { type: 'string' },
      'cdp-url': { type: 'string' },
      attach: { type: 'boolean' },
      'attach-port': { type: 'string' },
      wallet: { type: 'boolean' },
      'wallet-auto-approve': { type: 'boolean' },
      'wallet-password': { type: 'string' },
      'wallet-seed-url': { type: 'string', multiple: true },
      'wallet-preflight': { type: 'boolean' },
      'wallet-chain-id': { type: 'string' },
      'wallet-chain-rpc-url': { type: 'string' },
      memory: { type: 'boolean' },
      'memory-dir': { type: 'string' },

      // Output
      sink: { type: 'string', short: 's' },
      json: { type: 'boolean', default: false },
      quiet: { type: 'boolean', short: 'q', default: false },

      // Feature flags
      'goal-verification': { type: 'boolean' },
      'quality-threshold': { type: 'string' },
      'trace-scoring': { type: 'boolean' },
      'trace-ttl-days': { type: 'string' },
      vision: { type: 'boolean' },
      'vision-strategy': { type: 'string' },
      'observation-mode': { type: 'string' },
      debug: { type: 'boolean', short: 'd', default: false },

      // Resource blocking
      'block-analytics': { type: 'boolean', default: false },
      'block-images': { type: 'boolean', default: false },
      'block-media': { type: 'boolean', default: false },

      // Auth
      fill: { type: 'string', multiple: true },
      cookie: { type: 'string', multiple: true },
      'wait-for': { type: 'string' },
      'wait-timeout': { type: 'string' },

      // `bad share` flags
      visibility: { type: 'string' },
      'bad-app-url': { type: 'string' },
      'no-copy': { type: 'boolean' },

      // preview / stream / interrupt
      'max-steps': { type: 'string' },
      headed: { type: 'boolean' },
      stream: { type: 'string' },
      'stream-token': { type: 'string' },
      interrupt: { type: 'boolean' },

      // `bad snapshot` — headless, no-LLM accessibility dump
      out: { type: 'string' },
      wait: { type: 'string' },
      'dismiss-modals': { type: 'boolean' },

      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
}

export type ParsedCli = ReturnType<typeof parseCliArgs>;
export type CliValues = ParsedCli['values'];
export type CliPositionals = ParsedCli['positionals'];
