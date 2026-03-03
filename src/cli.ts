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
import { loadConfig, mergeConfig, toAgentConfig } from './config.js';
import type { DriverConfig } from './config.js';
import { buildBrowserLaunchPlan } from './browser-launch.js';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      // Config file
      config: { type: 'string' },

      // Test specification
      goal: { type: 'string', short: 'g' },
      url: { type: 'string', short: 'u' },
      cases: { type: 'string', short: 'c' },

      // LLM configuration
      model: { type: 'string', short: 'm' },
      provider: { type: 'string' },
      'api-key': { type: 'string' },
      'base-url': { type: 'string' },

      // Execution
      concurrency: { type: 'string' },
      'max-turns': { type: 'string' },
      'screenshot-interval': { type: 'string' },
      headless: { type: 'boolean' },
      timeout: { type: 'string' },
      extension: { type: 'string', multiple: true },
      'user-data-dir': { type: 'string' },
      wallet: { type: 'boolean' },

      // Output
      sink: { type: 'string', short: 's' },
      json: { type: 'boolean', default: false },
      quiet: { type: 'boolean', short: 'q', default: false },

      // Feature flags
      'goal-verification': { type: 'boolean' },
      'quality-threshold': { type: 'string' },
      vision: { type: 'boolean' },
      debug: { type: 'boolean', short: 'd', default: false },

      // Resource blocking
      'block-analytics': { type: 'boolean', default: false },
      'block-images': { type: 'boolean', default: false },
      'block-media': { type: 'boolean', default: false },

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

  // Load config file, then overlay CLI flags
  const fileConfig = await loadConfig(values.config);

  // Build CLI overrides (only set values that were explicitly passed)
  const cliOverrides: Partial<DriverConfig> = {};
  if (values.model) cliOverrides.model = values.model;
  if (values.provider) cliOverrides.provider = values.provider as DriverConfig['provider'];
  if (values['api-key']) cliOverrides.apiKey = values['api-key'];
  if (values['base-url']) cliOverrides.baseUrl = values['base-url'];
  if (values.concurrency) cliOverrides.concurrency = parseInt(values.concurrency, 10);
  if (values['max-turns']) cliOverrides.maxTurns = parseInt(values['max-turns'], 10);
  if (values['screenshot-interval']) cliOverrides.screenshotInterval = parseInt(values['screenshot-interval'], 10);
  if (values.timeout) cliOverrides.timeoutMs = parseInt(values.timeout, 10);
  if (values['quality-threshold']) cliOverrides.qualityThreshold = parseInt(values['quality-threshold'], 10);
  if (values.sink) cliOverrides.outputDir = values.sink;
  if (values.headless !== undefined) cliOverrides.headless = values.headless;
  if (values.vision !== undefined) cliOverrides.vision = values.vision;
  if (values['goal-verification'] !== undefined) cliOverrides.goalVerification = values['goal-verification'];
  if (values.extension?.length || values['user-data-dir'] || values.wallet !== undefined) {
    cliOverrides.wallet = {};
    if (values.extension?.length) cliOverrides.wallet.extensionPaths = values.extension;
    if (values['user-data-dir']) cliOverrides.wallet.userDataDir = values['user-data-dir'];
    if (values.wallet !== undefined) cliOverrides.wallet.enabled = values.wallet;
  }

  // Resource blocking
  if (values['block-analytics'] || values['block-images'] || values['block-media']) {
    cliOverrides.resourceBlocking = {};
    if (values['block-analytics']) cliOverrides.resourceBlocking.blockAnalytics = true;
    if (values['block-images']) cliOverrides.resourceBlocking.blockImages = true;
    if (values['block-media']) cliOverrides.resourceBlocking.blockMedia = true;
  }

  const driverConfig = mergeConfig(fileConfig, cliOverrides);
  const launchPlan = buildBrowserLaunchPlan(driverConfig);
  const quiet = values.quiet!;

  for (const warning of launchPlan.warnings) {
    if (!quiet) {
      console.warn(`Warning: ${warning}`);
    }
  }

  if (launchPlan.errors.length > 0) {
    for (const error of launchPlan.errors) {
      console.error(`Error: ${error}`);
    }
    process.exit(1);
  }

  // Dynamic imports — keeps startup fast and allows tree-shaking
  const { chromium } = await import('playwright');
  const { PlaywrightDriver } = await import('./drivers/playwright.js');
  const { TestRunner } = await import('./test-runner.js');
  const { FilesystemSink } = await import('./artifacts/filesystem-sink.js');

  const concurrency = launchPlan.concurrency;
  const maxTurns = driverConfig.maxTurns ?? 30;
  const screenshotInterval = driverConfig.screenshotInterval ?? 5;
  const timeoutMs = driverConfig.timeoutMs ?? 600_000;
  const debug = values.debug!;
  const sinkDir = driverConfig.outputDir ?? './agent-results';

  const config = {
    ...toAgentConfig(driverConfig),
    apiKey: driverConfig.apiKey || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY,
    baseUrl: driverConfig.baseUrl || process.env.LLM_BASE_URL,
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
    console.log(`Output: ${sinkDir}`);
    console.log('');
  }

  // Set up artifact sink
  const sink = new FilesystemSink(path.resolve(sinkDir));
  const videoDir = path.join(sinkDir, '_videos');
  const viewport = launchPlan.viewport;

  // Set up browser
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let persistentContext: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;

  if (launchPlan.walletMode) {
    for (const extensionPath of launchPlan.extensionPaths) {
      if (!fs.existsSync(extensionPath)) {
        throw new Error(`Wallet extension path does not exist: ${extensionPath}`);
      }
    }

    const userDataDir = launchPlan.userDataDir ?? path.resolve('.agent-wallet-profile');
    fs.mkdirSync(userDataDir, { recursive: true });

    persistentContext = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: false,
      args: launchPlan.browserArgs,
      viewport,
      recordVideo: { dir: videoDir, size: viewport },
    });
  } else {
    browser = await chromium.launch({
      headless: launchPlan.headless,
      args: launchPlan.browserArgs,
    });
  }

  const driverFactory = async () => {
    const context = persistentContext ?? await browser!.newContext({
      viewport,
      recordVideo: { dir: videoDir, size: viewport },
    });
    const page = await context.newPage();
    const driver = new PlaywrightDriver(page, {
      captureScreenshots: config.vision,
      screenshotQuality: 50,
    });
    // Apply resource blocking if configured
    if (driverConfig.resourceBlocking) {
      await driver.setupResourceBlocking(driverConfig.resourceBlocking);
    }
    // Wrap in a Driver that properly tears down context on close
    const wrappedDriver: import('./drivers/types.js').Driver = {
      observe: () => driver.observe(),
      execute: (action) => driver.execute(action),
      getPage: () => driver.getPage?.(),
      screenshot: () => driver.screenshot(),
      async close() {
        await page.close().catch(() => {});
        if (!persistentContext) {
          await context.close().catch(() => {});
        }
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
    defaultTimeoutMs: timeoutMs,
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

  // Write reports for each configured format
  const { generateReport } = await import('./test-report.js');
  const reporters = driverConfig.reporters ?? ['json'];
  const reportDir = path.resolve(sinkDir);
  fs.mkdirSync(reportDir, { recursive: true });

  const formatMeta: Record<string, { ext: string; contentType: string }> = {
    json: { ext: 'json', contentType: 'application/json' },
    markdown: { ext: 'md', contentType: 'text/markdown' },
    html: { ext: 'html', contentType: 'text/html' },
    junit: { ext: 'xml', contentType: 'application/xml' },
  };

  for (const format of reporters) {
    const meta = formatMeta[format];
    if (!meta) continue;
    try {
      const report = generateReport(result, { format, includeTurns: format === 'markdown' });
      const reportPath = path.join(reportDir, `report.${meta.ext}`);
      fs.writeFileSync(reportPath, report);
      if (!quiet) {
        console.log(`Report: ${reportPath}`);
      }
    } catch {
      // Report generation is best-effort
    }
  }

  // Also write report to stdout if JSON mode
  if (values.json && !quiet) {
    console.log(JSON.stringify(result, null, 2));
  }

  // Cleanup
  await singleDriver?.close?.();
  if (persistentContext) {
    await persistentContext.close();
  } else {
    await browser?.close();
  }

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
      --config <path>         Path to config file (default: auto-detect)
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
      --wallet               Enable wallet mode (persistent Chromium profile)
      --extension <path>     Load unpacked wallet/browser extension (repeatable)
      --user-data-dir <dir>  Persistent profile directory for wallet sessions
      --timeout <ms>          Per-test timeout in ms (default: 600000)
  -s, --sink <dir>            Output directory for artifacts (default: ./agent-results)
      --json                  Output progress as JSON lines (for piping)
  -q, --quiet                 Suppress all output
      --quality-threshold <n> Min quality score 1-10 (default: 0 = skip)
      --goal-verification     Verify goal completion (default: true)
      --no-goal-verification  Skip goal verification
      --vision                Enable vision/screenshots (default: true)
      --no-vision             Disable vision
      --block-analytics       Block analytics/tracking scripts
      --block-images          Block image loading
      --block-media           Block media loading (video, audio)
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
