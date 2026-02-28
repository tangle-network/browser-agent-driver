#!/usr/bin/env node

/**
 * CLI entry point — `agent-sandbox run`
 *
 * Distributes agent-browser-driver test suites across sandboxed environments.
 */

import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Coordinator } from './coordinator.js';
import { createProvider } from './providers/index.js';
import type { CoordinatorEvent, ProgressEvent, TestCase } from './types.js';

const HELP = `
agent-sandbox run [options]

Distribute agent-browser-driver test suites across sandboxed environments.

Options:
  --cases <file>             JSON file with test cases (required)
  --provider <name>          Sandbox provider: docker, tangle (default: docker)
  --concurrency <n>          Max parallel sandboxes (default: 2)
  --model <name>             LLM model (default: gpt-4o)
  --llm-provider <name>      LLM provider: openai, anthropic, google (default: openai)
  --api-key <key>            LLM API key (or set via env: OPENAI_API_KEY, etc.)
  --base-url <url>           LLM base URL override
  --orchestrator-url <url>   Tangle orchestrator URL (for --provider tangle)
  --tangle-api-key <key>     Tangle sandbox API key (for --provider tangle)
  --docker-image <name>      Docker image (for --provider docker, default: agent-driver)
  --output <dir>             Output directory (default: ./sandbox-results)
  --max-turns <n>            Max turns per test case
  --json                     Output as JSON lines only
  --quiet                    Suppress progress output
  --help                     Show this help
`.trim();

/** Narrow parseArgs values to string | undefined */
function str(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function main(): void {
  const { values } = parseArgs({
    options: {
      cases: { type: 'string' },
      provider: { type: 'string', default: 'docker' },
      concurrency: { type: 'string', default: '2' },
      model: { type: 'string', default: 'gpt-4o' },
      'llm-provider': { type: 'string', default: 'openai' },
      'api-key': { type: 'string' },
      'base-url': { type: 'string' },
      'orchestrator-url': { type: 'string' },
      'tangle-api-key': { type: 'string' },
      'docker-image': { type: 'string' },
      output: { type: 'string', default: './sandbox-results' },
      'max-turns': { type: 'string' },
      json: { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: false,
    allowPositionals: true,
  });

  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }

  const casesFile = str(values.cases);
  if (!casesFile) {
    console.error('Error: --cases <file> is required\n');
    console.error(HELP);
    process.exit(1);
  }

  // Load test cases
  const casesPath = resolve(casesFile);
  let cases: TestCase[];
  try {
    const raw = readFileSync(casesPath, 'utf-8');
    cases = JSON.parse(raw) as TestCase[];
    if (!Array.isArray(cases) || cases.length === 0) {
      throw new Error('Cases file must contain a non-empty JSON array');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error loading cases from ${casesPath}: ${msg}`);
    process.exit(1);
  }

  const providerName = str(values.provider) ?? 'docker';
  const concurrency = parseInt(str(values.concurrency) ?? '2', 10);
  const jsonMode = values.json === true;
  const quiet = values.quiet === true;
  const outputDir = str(values.output) ?? './sandbox-results';
  const model = str(values.model) ?? 'gpt-4o';
  const llmProvider = str(values['llm-provider']) ?? 'openai';
  const apiKey = str(values['api-key'])
    ?? process.env.OPENAI_API_KEY
    ?? process.env.ANTHROPIC_API_KEY
    ?? process.env.GOOGLE_API_KEY;
  const baseUrl = str(values['base-url']);
  const maxTurnsStr = str(values['max-turns']);
  const tangleApiKey = str(values['tangle-api-key']);
  const orchestratorUrl = str(values['orchestrator-url']);
  const dockerImage = str(values['docker-image']);

  // Progress handler
  const onProgress = (event: CoordinatorEvent): void => {
    if (quiet) return;

    if (jsonMode) {
      console.log(JSON.stringify(event));
      return;
    }

    switch (event.type) {
      case 'coordinator:start':
        console.log(`\nStarting ${event.totalTests} tests across ${event.sandboxes} sandboxes...\n`);
        break;
      case 'sandbox:provisioned':
        console.log(`  [${event.sandboxId}] Provisioned (${event.testsAssigned} tests assigned)`);
        break;
      case 'sandbox:started':
        console.log(`  [${event.sandboxId}] Running tests...`);
        break;
      case 'sandbox:progress':
        formatProgressEvent(event.sandboxId, event.event);
        break;
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
        console.log(`  Output: ${outputDir}`);
        console.log('='.repeat(60));
        break;
      }
    }
  };

  // Run
  void (async () => {
    try {
      const provider = await createProvider(
        providerName === 'tangle'
          ? {
            type: 'tangle' as const,
            config: {
              apiKey: tangleApiKey,
              baseUrl: orchestratorUrl,
            },
          }
          : {
            type: 'docker' as const,
            config: {
              image: dockerImage,
            },
          }
      );

      const coordinator = new Coordinator({
        provider,
        concurrency,
        cases,
        agentConfig: {
          model,
          provider: llmProvider,
          apiKey,
          baseUrl,
          maxTurns: maxTurnsStr ? parseInt(maxTurnsStr, 10) : undefined,
        },
        onProgress,
        outputDir,
      });

      const result = await coordinator.run();

      // Exit with appropriate code
      process.exit(result.summary.failed > 0 ? 1 : 0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\nFatal error: ${msg}`);
      process.exit(2);
    }
  })();
}

function formatProgressEvent(sandboxId: string, event: ProgressEvent): void {
  switch (event.type) {
    case 'test:start':
      console.log(`    [${sandboxId}] Starting: ${event.testName}`);
      break;
    case 'test:turn':
      console.log(`    [${sandboxId}] Turn ${event.turn}: ${event.action} (${event.durationMs}ms)`);
      break;
    case 'test:complete':
      console.log(`    [${sandboxId}] ${event.passed ? 'PASS' : 'FAIL'}: ${event.testId} (${event.turnsUsed} turns, ${(event.durationMs / 1000).toFixed(1)}s)`);
      break;
    case 'suite:complete':
      // Handled at coordinator level
      break;
    default:
      break;
  }
}

main();
