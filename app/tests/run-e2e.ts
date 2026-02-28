/**
 * E2E test runner — exercises the full sandbox orchestration pipeline:
 *
 *   Coordinator → TangleSandboxProvider → @tangle/sandbox SDK → orchestrator
 *     → sidecar containers → agent-driver run → Playwright → ai.tangle.tools
 *
 * Or with Docker:
 *   Coordinator → DockerSandboxProvider → Docker containers → agent-driver run
 *     → Playwright → ai.tangle.tools
 *
 * Usage:
 *   npx tsx tests/run-e2e.ts                           # Tangle provider (default)
 *   npx tsx tests/run-e2e.ts --provider docker          # Docker provider
 *   npx tsx tests/run-e2e.ts --cases tests/cases.json   # Custom cases
 *   npx tsx tests/run-e2e.ts --concurrency 2            # Parallel sandboxes
 */

import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Coordinator } from '../src/coordinator.js';
import type { CoordinatorEvent, TestCase } from '../src/types.js';

const { values } = parseArgs({
  options: {
    cases: { type: 'string', default: resolve(import.meta.dirname, 'cases.json') },
    provider: { type: 'string', default: 'tangle' },
    concurrency: { type: 'string', default: '2' },
    output: { type: 'string', default: './sandbox-results' },
    model: { type: 'string' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
  strict: false,
});

if (values.help) {
  console.log(`
Usage: npx tsx tests/run-e2e.ts [options]

Options:
  --cases <file>       Test cases JSON (default: tests/cases.json)
  --provider <name>    docker or tangle (default: tangle)
  --concurrency <n>    Parallel sandboxes (default: 2)
  --output <dir>       Output directory (default: ./sandbox-results)
  --model <name>       Override LLM model
  --json               JSON-only output
  --help               Show help
  `.trim());
  process.exit(0);
}

function formatEvent(event: CoordinatorEvent): void {
  if (values.json) {
    console.log(JSON.stringify(event));
    return;
  }

  switch (event.type) {
    case 'coordinator:start':
      console.log(`\nStarting ${event.totalTests} tests across ${event.sandboxes} sandboxes...\n`);
      break;
    case 'sandbox:provisioned':
      console.log(`  [${event.sandboxId}] Provisioned (${event.testsAssigned} tests)`);
      break;
    case 'sandbox:started':
      console.log(`  [${event.sandboxId}] Running...`);
      break;
    case 'sandbox:progress': {
      const pe = event.event;
      if (pe.type === 'test:start') {
        console.log(`    [${event.sandboxId}] START: ${pe.testName}`);
      } else if (pe.type === 'test:turn') {
        console.log(`    [${event.sandboxId}] turn ${pe.turn}: ${pe.action} (${pe.durationMs}ms)`);
      } else if (pe.type === 'test:complete') {
        console.log(`    [${event.sandboxId}] ${pe.passed ? 'PASS' : 'FAIL'}: ${pe.testId} (${pe.turnsUsed} turns)`);
      }
      break;
    }
    case 'sandbox:completed':
      console.log(`  [${event.sandboxId}] Done: ${event.passed} passed, ${event.failed} failed`);
      break;
    case 'sandbox:failed':
      console.error(`  [${event.sandboxId}] FAILED: ${event.error}`);
      break;
    case 'coordinator:complete': {
      const s = event.result.summary;
      console.log(`\n${'='.repeat(60)}`);
      console.log(`Results: ${s.passed}/${s.total} passed (${(s.passRate * 100).toFixed(1)}%)`);
      console.log(`  Failed: ${s.failed} | Skipped: ${s.skipped}`);
      console.log(`  Duration: ${(s.totalDurationMs / 1000).toFixed(1)}s across ${s.sandboxesUsed} sandboxes`);
      console.log('='.repeat(60));
      break;
    }
  }
}

async function main(): Promise<void> {
  // Load test cases
  const casesPath = resolve(typeof values.cases === 'string' ? values.cases : 'tests/cases.json');
  const cases = JSON.parse(readFileSync(casesPath, 'utf-8')) as TestCase[];
  console.log(`Loaded ${cases.length} test cases from ${casesPath}`);

  const providerName = typeof values.provider === 'string' ? values.provider : 'tangle';
  const concurrency = parseInt(typeof values.concurrency === 'string' ? values.concurrency : '2', 10);
  const outputDir = typeof values.output === 'string' ? values.output : './sandbox-results';

  let provider;
  let llmProvider: 'openai' | 'anthropic' = 'openai';
  let llmApiKey: string | undefined;
  let model: string;

  if (providerName === 'tangle') {
    // Start orchestrator + resolve keys
    const { ensureOrchestrator } = await import('./setup.js');
    const config = await ensureOrchestrator();

    const { TangleSandboxProvider } = await import('../src/providers/tangle.js');
    provider = new TangleSandboxProvider({
      apiKey: config.apiKey,
      baseUrl: config.sdkUrl,
    });
    llmProvider = config.llmProvider;
    llmApiKey = config.llmApiKey;
    model = config.llmProvider === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o';
  } else {
    // Docker provider
    const { DockerSandboxProvider } = await import('../src/providers/docker.js');
    provider = new DockerSandboxProvider({ image: 'agent-driver' });
    llmApiKey = process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY;
    llmProvider = process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'openai';
    model = llmProvider === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o';
  }

  // Override model if specified
  if (typeof values.model === 'string') {
    model = values.model;
  }

  console.log(`Provider: ${providerName} | Model: ${llmProvider}/${model} | Concurrency: ${concurrency}`);

  const coordinator = new Coordinator({
    provider,
    concurrency,
    cases,
    agentConfig: {
      model,
      provider: llmProvider,
      apiKey: llmApiKey,
      vision: true,
      goalVerification: true,
    },
    onProgress: formatEvent,
    outputDir,
  });

  const result = await coordinator.run();

  // Write full result
  console.log(`\nFull results written to ${outputDir}/aggregated-result.json`);

  // Cleanup
  if (providerName === 'tangle') {
    const { teardownOrchestrator } = await import('./setup.js');
    teardownOrchestrator();
  }

  process.exit(result.summary.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('E2E run failed:', err instanceof Error ? err.message : err);
  process.exit(2);
});
