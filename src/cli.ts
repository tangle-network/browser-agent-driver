#!/usr/bin/env node

/**
 * CLI for agent-browser-driver — run agent test cases from the command line.
 *
 * Usage:
 *   agent-driver run --goal "Sign up" --url http://localhost:3000
 *   agent-driver run --cases ./cases.json --concurrency 4
 *   agent-driver run --cases ./cases.json --sink ./results/ --model claude-sonnet-4-20250514
 *
 * Designed for sandbox/container execution:
 *   docker run agent-driver run --cases /data/cases.json --sink /output/
 */

import { parseArgs } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      // Test specification
      goal: { type: 'string', short: 'g' },
      url: { type: 'string', short: 'u' },
      cases: { type: 'string', short: 'c' },

      // LLM configuration
      model: { type: 'string', short: 'm', default: 'gpt-4o' },
      provider: { type: 'string', default: 'openai' },
      'api-key': { type: 'string' },
      'base-url': { type: 'string' },

      // Execution
      concurrency: { type: 'string', default: '1' },
      'max-turns': { type: 'string', default: '30' },
      'screenshot-interval': { type: 'string', default: '5' },
      headless: { type: 'boolean', default: true },
      timeout: { type: 'string', default: '600000' },

      // Output
      sink: { type: 'string', short: 's', default: './agent-results' },
      json: { type: 'boolean', default: false },
      quiet: { type: 'boolean', short: 'q', default: false },

      // Feature flags
      'goal-verification': { type: 'boolean', default: true },
      'quality-threshold': { type: 'string', default: '0' },
      vision: { type: 'boolean', default: true },
      debug: { type: 'boolean', short: 'd', default: false },

      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });

  if (values.version) {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
    console.log(pkg.version);
    process.exit(0);
  }

  if (values.help || positionals.length === 0) {
    printHelp();
    process.exit(0);
  }

  const command = positionals[0];

  if (command !== 'run') {
    console.error(`Unknown command: ${command}. Use "run".`);
    process.exit(1);
  }

  // Validate inputs
  if (!values.goal && !values.cases) {
    console.error('Error: provide --goal "..." --url "..." for a single task, or --cases ./cases.json for a suite.');
    process.exit(1);
  }

  // Dynamic imports — keeps startup fast and allows tree-shaking
  const { chromium } = await import('playwright');
  const { PlaywrightDriver } = await import('./drivers/playwright.js');
  const { TestRunner } = await import('./test-runner.js');
  const { FilesystemSink } = await import('./artifacts/filesystem-sink.js');

  const concurrency = parseInt(values.concurrency!, 10);
  const maxTurns = parseInt(values['max-turns']!, 10);
  const screenshotInterval = parseInt(values['screenshot-interval']!, 10);
  const timeoutMs = parseInt(values.timeout!, 10);
  const qualityThreshold = parseInt(values['quality-threshold']!, 10);
  const quiet = values.quiet!;
  const debug = values.debug!;

  const config = {
    provider: values.provider as 'openai' | 'anthropic' | 'google',
    model: values.model!,
    apiKey: values['api-key'] || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY,
    baseUrl: values['base-url'] || process.env.LLM_BASE_URL,
    vision: values.vision!,
    goalVerification: values['goal-verification']!,
    qualityThreshold,
    debug,
  };

  // Build test cases
  let cases: import('./types.js').TestCase[];

  if (values.cases) {
    const raw = fs.readFileSync(path.resolve(values.cases), 'utf-8');
    const parsed = JSON.parse(raw);
    const rawCases: Record<string, unknown>[] = Array.isArray(parsed) ? parsed : [parsed];
    // Ensure required fields — spread raw case first so explicit fields become defaults
    cases = rawCases.map((c, i) => ({
      id: (c.id as string) || `case-${i}`,
      name: (c.name as string) || (c.goal as string)?.slice(0, 60) || `Case ${i}`,
      startUrl: (c.startUrl as string) || (c.url as string) || values.url || '',
      goal: (c.goal as string) || '',
      maxTurns: (c.maxTurns as number) || maxTurns,
      timeoutMs: (c.timeoutMs as number) || timeoutMs,
      priority: (c.priority as number) ?? i,
    }));
  } else {
    cases = [{
      id: 'cli-task',
      name: values.goal!.slice(0, 60),
      startUrl: values.url || '',
      goal: values.goal!,
      maxTurns,
      timeoutMs,
      priority: 0,
    }];
  }

  if (!quiet) {
    console.log(`agent-driver v${JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8')).version}`);
    console.log(`Model: ${config.provider}/${config.model} | Tests: ${cases.length} | Concurrency: ${concurrency}`);
    console.log(`Output: ${values.sink}`);
    console.log('');
  }

  // Set up artifact sink
  const sink = new FilesystemSink(path.resolve(values.sink!));

  // Set up browser
  const browser = await chromium.launch({ headless: values.headless });

  const driverFactory = async () => {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      recordVideo: { dir: path.join(values.sink!, '_videos'), size: { width: 1920, height: 1080 } },
    });
    const page = await context.newPage();
    const driver = new PlaywrightDriver(page, {
      captureScreenshots: config.vision,
      screenshotQuality: 50,
    });
    // Wrap in a Driver that properly tears down context on close
    const wrappedDriver: import('./drivers/types.js').Driver = {
      observe: () => driver.observe(),
      execute: (action) => driver.execute(action),
      getPage: () => driver.getPage?.(),
      screenshot: () => driver.screenshot(),
      async close() {
        await page.close().catch(() => {});
        await context.close().catch(() => {});
      },
    };
    return wrappedDriver;
  };

  // Create a single driver for sequential mode
  let singleDriver: import('./drivers/types.js').Driver | undefined;
  if (concurrency <= 1) {
    singleDriver = await driverFactory();
  }

  const runner = new TestRunner({
    config,
    driver: singleDriver,
    driverFactory: concurrency > 1 ? driverFactory : undefined,
    concurrency,
    screenshotInterval,
    artifactSink: sink,
    onProgress: (event) => {
      if (quiet) return;
      if (values.json) {
        console.log(JSON.stringify(event));
        return;
      }
      switch (event.type) {
        case 'test:start':
          console.log(`  ▶ ${event.testName}`);
          break;
        case 'test:turn':
          if (debug) {
            console.log(`    turn ${event.turn}: ${event.action} (${event.durationMs}ms)`);
          }
          break;
        case 'test:complete':
          console.log(`  ${event.passed ? '✓' : '✗'} ${event.testId} — ${event.verdict.slice(0, 80)} (${event.turnsUsed} turns, ${Math.round(event.durationMs / 1000)}s)`);
          break;
        case 'suite:complete':
          console.log('');
          console.log(`Done: ${event.passed} passed, ${event.failed} failed, ${event.skipped} skipped (${Math.round(event.totalMs / 1000)}s)`);
          if (event.manifestUri) {
            console.log(`Artifacts: ${event.manifestUri}`);
          }
          break;
      }
    },
  });

  const result = await runner.runSuite(cases);

  // Also write report to stdout if JSON mode
  if (values.json && !quiet) {
    console.log(JSON.stringify(result, null, 2));
  }

  // Cleanup
  await singleDriver?.close?.();
  await browser.close();

  // Exit code based on results
  process.exit(result.summary.failed > 0 ? 1 : 0);
}

function printHelp(): void {
  console.log(`
agent-driver — LLM-driven browser automation CLI

USAGE:
  agent-driver run [options]

SINGLE TASK:
  agent-driver run --goal "Sign up for account" --url http://localhost:3000
  agent-driver run -g "Build a todo app" -u http://localhost:5173 -m claude-sonnet-4-20250514

TEST SUITE:
  agent-driver run --cases ./cases.json --concurrency 4
  agent-driver run --cases ./cases.json --sink ./results/ --model gpt-4o

DOCKER:
  docker run -v ./cases.json:/data/cases.json -v ./out:/output \\
    agent-driver run --cases /data/cases.json --sink /output/

OPTIONS:
  -g, --goal <text>           Natural language goal for single task
  -u, --url <url>             Starting URL
  -c, --cases <file>          JSON file with test cases array
  -m, --model <name>          LLM model (default: gpt-4o)
      --provider <name>       LLM provider: openai, anthropic, google (default: openai)
      --api-key <key>         API key (or set OPENAI_API_KEY / ANTHROPIC_API_KEY)
      --base-url <url>        Custom LLM endpoint (e.g., LiteLLM proxy)
      --concurrency <n>       Parallel workers (default: 1)
      --max-turns <n>         Max turns per test (default: 30)
      --screenshot-interval <n>  Capture every N turns (default: 5)
      --headless              Run browser headless (default: true)
      --no-headless           Show browser window
      --timeout <ms>          Per-test timeout in ms (default: 600000)
  -s, --sink <dir>            Output directory for artifacts (default: ./agent-results)
      --json                  Output progress as JSON lines (for piping)
  -q, --quiet                 Suppress all output
      --quality-threshold <n> Min quality score 1-10 (default: 0 = skip)
      --goal-verification     Verify goal completion (default: true)
      --no-goal-verification  Skip goal verification
      --vision                Enable vision/screenshots (default: true)
      --no-vision             Disable vision
  -d, --debug                 Enable debug logging
  -h, --help                  Show this help
  -v, --version               Show version

TEST CASES JSON FORMAT:
  [
    {
      "id": "signup",
      "name": "User signup flow",
      "goal": "Create a new account with email test@example.com",
      "startUrl": "http://localhost:3000/signup",
      "maxTurns": 20,
      "timeoutMs": 300000,
      "successDescription": "Account created and redirected to dashboard"
    }
  ]

ENVIRONMENT VARIABLES:
  OPENAI_API_KEY       OpenAI API key
  ANTHROPIC_API_KEY    Anthropic API key
  LLM_BASE_URL         Custom LLM endpoint URL
`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
