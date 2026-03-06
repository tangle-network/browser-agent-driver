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
import { spawn } from 'node:child_process';
import type { BrowserContext } from 'playwright';
import { loadConfig, mergeConfig, toAgentConfig } from './config.js';
import type { DriverConfig } from './config.js';
import { buildBrowserLaunchPlan } from './browser-launch.js';
import { runWalletPreflight, startWalletAutoApprover } from './wallet/automation.js';
import { isPersonaId, listPersonaIds, withPersonaDirective } from './personas.js';
import { resolveProviderModelName } from './provider-defaults.js';
import { loadLocalEnvFiles } from './env-loader.js';

type RunMode = 'fast-explore' | 'full-evidence';
const RUN_MODES: RunMode[] = ['fast-explore', 'full-evidence'];
type DriverProfile = NonNullable<DriverConfig['profile']>;
const DRIVER_PROFILES: DriverProfile[] = ['default', 'stealth', 'benchmark-webbench', 'benchmark-webvoyager'];

type StorageStateFile = {
  cookies?: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
  }>;
  origins?: Array<{
    origin: string;
    localStorage?: Array<{ name: string; value: string }>;
  }>;
};

async function applyStorageStateToPersistentContext(context: BrowserContext, storageStatePath?: string): Promise<void> {
  if (!storageStatePath) return;

  const parsed = JSON.parse(fs.readFileSync(storageStatePath, 'utf-8')) as StorageStateFile;
  const cookies = parsed.cookies ?? [];
  if (cookies.length > 0) {
    await context.addCookies(cookies);
  }

  const origins = parsed.origins ?? [];
  if (origins.length === 0) return;

  const existingPages = context.pages();
  const page = existingPages[0] ?? await context.newPage();
  const createdTempPage = existingPages.length === 0;

  try {
    for (const originState of origins) {
      if (!originState?.origin || !Array.isArray(originState.localStorage) || originState.localStorage.length === 0) {
        continue;
      }
      await page.goto(originState.origin, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.evaluate((entries) => {
        for (const entry of entries) {
          try {
            localStorage.setItem(entry.name, entry.value);
          } catch {
            // Best effort: some origins may block storage writes.
          }
        }
      }, originState.localStorage);
    }
  } finally {
    if (createdTempPage) {
      await page.close().catch(() => {});
    }
  }
}

async function main(): Promise<void> {
  loadLocalEnvFiles(process.cwd());

  const { values, positionals } = parseArgs({
    allowPositionals: true,
    allowNegative: true,
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
      'model-adaptive': { type: 'boolean' },
      'nav-model': { type: 'string' },
      'nav-provider': { type: 'string' },
      persona: { type: 'string' },
      mode: { type: 'string' },
      profile: { type: 'string' },
      'prompt-file': { type: 'string' },
      'api-key': { type: 'string' },
      'base-url': { type: 'string' },

      // Execution
      browser: { type: 'string' },
      'storage-state': { type: 'string' },
      concurrency: { type: 'string' },
      'max-turns': { type: 'string' },
      'llm-timeout': { type: 'string' },
      retries: { type: 'string' },
      'retry-delay-ms': { type: 'string' },
      'screenshot-interval': { type: 'string' },
      headless: { type: 'boolean' },
      timeout: { type: 'string' },
      extension: { type: 'string', multiple: true },
      'user-data-dir': { type: 'string' },
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

  const mode = values.mode;
  if (mode && !RUN_MODES.includes(mode as RunMode)) {
    console.error(`Error: unknown mode "${mode}". Valid modes: ${RUN_MODES.join(', ')}`);
    process.exit(1);
  }

  const profile = values.profile;
  if (profile && !DRIVER_PROFILES.includes(profile as DriverProfile)) {
    console.error(`Error: unknown profile "${profile}". Valid profiles: ${DRIVER_PROFILES.join(', ')}`);
    process.exit(1);
  }

  // Build CLI overrides (only set values that were explicitly passed)
  const cliOverrides: Partial<DriverConfig> = {};
  if (values.model) cliOverrides.model = values.model;
  if (values.provider) cliOverrides.provider = values.provider as DriverConfig['provider'];
  if (values['model-adaptive'] !== undefined) cliOverrides.adaptiveModelRouting = values['model-adaptive'];
  if (values['nav-model']) cliOverrides.navModel = values['nav-model'];
  if (values['nav-provider']) cliOverrides.navProvider = values['nav-provider'] as DriverConfig['navProvider'];
  if (values['api-key']) cliOverrides.apiKey = values['api-key'];
  if (values['base-url']) cliOverrides.baseUrl = values['base-url'];
  if (values['prompt-file']) {
    const promptPath = path.resolve(values['prompt-file']);
    if (!fs.existsSync(promptPath)) {
      console.error(`Error: prompt file not found: ${promptPath}`);
      process.exit(1);
    }
    cliOverrides.systemPrompt = fs.readFileSync(promptPath, 'utf-8').trim();
    if (!cliOverrides.systemPrompt) {
      console.error(`Error: prompt file is empty: ${promptPath}`);
      process.exit(1);
    }
  }
  if (profile) cliOverrides.profile = profile as DriverProfile;
  if (values.browser) cliOverrides.browser = values.browser as DriverConfig['browser'];
  if (values['storage-state']) cliOverrides.storageState = values['storage-state'];
  if (values.concurrency) cliOverrides.concurrency = parseInt(values.concurrency, 10);
  if (values['max-turns']) cliOverrides.maxTurns = parseInt(values['max-turns'], 10);
  if (values['llm-timeout']) cliOverrides.llmTimeoutMs = parseInt(values['llm-timeout'], 10);
  if (values.retries) cliOverrides.retries = parseInt(values.retries, 10);
  if (values['retry-delay-ms']) cliOverrides.retryDelayMs = parseInt(values['retry-delay-ms'], 10);
  if (values['screenshot-interval']) cliOverrides.screenshotInterval = parseInt(values['screenshot-interval'], 10);
  if (values.timeout) cliOverrides.timeoutMs = parseInt(values.timeout, 10);
  if (values['quality-threshold']) cliOverrides.qualityThreshold = parseInt(values['quality-threshold'], 10);
  if (values['trace-scoring'] !== undefined || values['trace-ttl-days']) {
    cliOverrides.memory = {
      ...(cliOverrides.memory ?? {}),
    };
    if (values['trace-scoring'] !== undefined) cliOverrides.memory.traceScoring = values['trace-scoring'];
    if (values['trace-ttl-days']) cliOverrides.memory.traceTtlDays = parseInt(values['trace-ttl-days'], 10);
  }
  if (values.sink) cliOverrides.outputDir = values.sink;
  if (values.headless !== undefined) cliOverrides.headless = values.headless;
  if (values.vision !== undefined) cliOverrides.vision = values.vision;
  if (values['goal-verification'] !== undefined) cliOverrides.goalVerification = values['goal-verification'];
  if (
    values.extension?.length ||
    values['user-data-dir'] ||
    values.wallet !== undefined ||
    values['wallet-auto-approve'] !== undefined ||
    values['wallet-password'] ||
    values['wallet-seed-url']?.length ||
    values['wallet-preflight'] !== undefined ||
    values['wallet-chain-id'] ||
    values['wallet-chain-rpc-url']
  ) {
    cliOverrides.wallet = {};
    if (values.extension?.length) cliOverrides.wallet.extensionPaths = values.extension;
    if (values['user-data-dir']) cliOverrides.wallet.userDataDir = values['user-data-dir'];
    if (values.wallet !== undefined) cliOverrides.wallet.enabled = values.wallet;
    if (values['wallet-auto-approve'] !== undefined) {
      cliOverrides.wallet.autoApprove = values['wallet-auto-approve'];
    }
    if (values['wallet-password']) {
      cliOverrides.wallet.password = values['wallet-password'];
    }
    if (
      values['wallet-seed-url']?.length ||
      values['wallet-preflight'] !== undefined ||
      values['wallet-chain-id'] ||
      values['wallet-chain-rpc-url']
    ) {
      cliOverrides.wallet.preflight = {};
      if (values['wallet-seed-url']?.length) {
        cliOverrides.wallet.preflight.seedUrls = values['wallet-seed-url'];
      }
      if (values['wallet-preflight'] !== undefined) {
        cliOverrides.wallet.preflight.enabled = values['wallet-preflight'];
      }
      if (values['wallet-chain-id'] || values['wallet-chain-rpc-url']) {
        cliOverrides.wallet.preflight.chain = {};
        if (values['wallet-chain-id']) {
          const parsedChainId = parseInt(values['wallet-chain-id'], 10);
          if (!Number.isFinite(parsedChainId)) {
            throw new Error(`Invalid --wallet-chain-id value: ${values['wallet-chain-id']}`);
          }
          cliOverrides.wallet.preflight.chain.id = parsedChainId;
        }
        if (values['wallet-chain-rpc-url']) {
          cliOverrides.wallet.preflight.chain.rpcUrl = values['wallet-chain-rpc-url'];
        }
      }
    }
  }
  if (values.memory !== undefined || values['memory-dir']) {
    cliOverrides.memory = {
      ...(cliOverrides.memory ?? {}),
    };
    if (values.memory !== undefined) cliOverrides.memory.enabled = values.memory;
    if (values['memory-dir']) cliOverrides.memory.dir = values['memory-dir'];
  }

  // Resource blocking
  if (values['block-analytics'] || values['block-images'] || values['block-media']) {
    cliOverrides.resourceBlocking = {};
    if (values['block-analytics']) cliOverrides.resourceBlocking.blockAnalytics = true;
    if (values['block-images']) cliOverrides.resourceBlocking.blockImages = true;
    if (values['block-media']) cliOverrides.resourceBlocking.blockMedia = true;
  }

  // Profile presets apply only when equivalent flags were not explicitly set.
  if (profile === 'stealth') {
    if (values.headless === undefined) cliOverrides.headless = false;
    if (values['goal-verification'] === undefined) cliOverrides.goalVerification = true;
    if (!values['screenshot-interval']) cliOverrides.screenshotInterval = 2;
    if (!values['block-analytics'] && !values['block-images'] && !values['block-media']) {
      cliOverrides.resourceBlocking = {
        ...(cliOverrides.resourceBlocking ?? {}),
        blockAnalytics: true,
      };
    }
    cliOverrides.microPlan = {
      ...(cliOverrides.microPlan ?? {}),
      enabled: true,
      maxActionsPerTurn: cliOverrides.microPlan?.maxActionsPerTurn ?? 2,
    };
  } else if (profile === 'benchmark-webbench') {
    if (!values['llm-timeout']) cliOverrides.llmTimeoutMs = 20_000;
    if (!values.retries) cliOverrides.retries = 1;
    if (!values['retry-delay-ms']) cliOverrides.retryDelayMs = 250;
    if (values.vision === undefined) cliOverrides.vision = false;
    if (!values['screenshot-interval']) cliOverrides.screenshotInterval = 0;
    if (values['goal-verification'] === undefined) cliOverrides.goalVerification = true;
    if (!values['block-analytics'] && !values['block-images'] && !values['block-media']) {
      cliOverrides.resourceBlocking = {
        ...(cliOverrides.resourceBlocking ?? {}),
        blockAnalytics: true,
        blockImages: true,
        blockMedia: true,
      };
    }
    cliOverrides.microPlan = {
      ...(cliOverrides.microPlan ?? {}),
      enabled: true,
      maxActionsPerTurn: cliOverrides.microPlan?.maxActionsPerTurn ?? 2,
    };
  } else if (profile === 'benchmark-webvoyager') {
    if (values.vision === undefined) cliOverrides.vision = true;
    if (!values['screenshot-interval']) cliOverrides.screenshotInterval = 2;
    if (values['goal-verification'] === undefined) cliOverrides.goalVerification = true;
    cliOverrides.microPlan = {
      ...(cliOverrides.microPlan ?? {}),
      enabled: true,
      maxActionsPerTurn: cliOverrides.microPlan?.maxActionsPerTurn ?? 2,
    };
  }

  // Mode presets apply only when equivalent flags were not explicitly set.
  if (mode === 'fast-explore') {
    if (values.vision === undefined) cliOverrides.vision = false;
    if (!values['screenshot-interval']) cliOverrides.screenshotInterval = 0;
    if (values['goal-verification'] === undefined) cliOverrides.goalVerification = true;
    if (values['quality-threshold'] === undefined) cliOverrides.qualityThreshold = 0;
    if (!values['block-analytics'] && !values['block-images'] && !values['block-media']) {
      cliOverrides.resourceBlocking = {
        ...(cliOverrides.resourceBlocking ?? {}),
        blockAnalytics: true,
      };
    }
  } else if (mode === 'full-evidence') {
    if (values.vision === undefined) cliOverrides.vision = true;
    if (!values['screenshot-interval']) cliOverrides.screenshotInterval = 3;
    if (values['goal-verification'] === undefined) cliOverrides.goalVerification = true;
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
  const { chromium, firefox, webkit } = await import('playwright');
  const { PlaywrightDriver } = await import('./drivers/playwright.js');
  const { TestRunner } = await import('./test-runner.js');
  const { FilesystemSink } = await import('./artifacts/filesystem-sink.js');

  const concurrency = launchPlan.concurrency;
  const maxTurns = driverConfig.maxTurns ?? 30;
  const screenshotInterval = driverConfig.screenshotInterval ?? 5;
  const timeoutMs = driverConfig.timeoutMs ?? 600_000;
  const browserName = driverConfig.browser ?? 'chromium';
  const debug = values.debug!;
  const sinkDir = driverConfig.outputDir ?? './agent-results';

  const resolvedProvider = driverConfig.provider || 'openai';
  const resolvedApiKey = resolveProviderApiKey(resolvedProvider, driverConfig.apiKey);
  const resolvedModel = resolveProviderModelName(resolvedProvider, driverConfig.model);
  const resolvedNavProvider = driverConfig.navProvider || resolvedProvider;
  const resolvedNavModel = driverConfig.navModel
    ? resolveProviderModelName(resolvedNavProvider, driverConfig.navModel)
    : undefined;
  const resolvedSupervisorProvider = driverConfig.supervisor?.provider || resolvedProvider;
  const resolvedSupervisorModel = resolveProviderModelName(
    resolvedSupervisorProvider,
    driverConfig.supervisor?.model || resolvedModel,
  );
  const config = {
    ...toAgentConfig(driverConfig),
    model: resolvedModel,
    ...(resolvedNavModel ? { navModel: resolvedNavModel } : {}),
    apiKey: resolvedApiKey,
    baseUrl: driverConfig.baseUrl || process.env.LLM_BASE_URL,
    supervisor: driverConfig.supervisor
      ? {
          ...driverConfig.supervisor,
          provider: resolvedSupervisorProvider,
          model: resolvedSupervisorModel,
        }
      : undefined,
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

  const persona = values.persona;
  if (persona) {
    if (!isPersonaId(persona)) {
      console.error(
        `Error: unknown persona "${persona}". ` +
        `Valid personas: ${listPersonaIds().join(', ')}`
      );
      process.exit(1);
    }
    cases = cases.map((c) => ({
      ...c,
      goal: withPersonaDirective({
        persona,
        goal: c.goal,
        startUrl: c.startUrl,
      }),
    }));
  }

  if (!quiet && !values.json) {
    console.log(`agent-driver v${JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8')).version}`);
    console.log(`Model: ${config.provider}/${config.model} | Browser: ${browserName} | Tests: ${cases.length} | Concurrency: ${concurrency}`);
    if (mode) console.log(`Mode: ${mode}`);
    if (driverConfig.profile && driverConfig.profile !== 'default') {
      console.log(`Profile: ${driverConfig.profile}`);
    }
    if (config.adaptiveModelRouting) {
      console.log(`Adaptive routing: ON (nav=${config.navProvider || config.provider}/${config.navModel || config.model})`);
    }
    console.log(`Output: ${sinkDir}`);
    console.log('');
  }

  // Set up artifact sink
  const sink = new FilesystemSink(path.resolve(sinkDir));
  const videoDir = path.join(sinkDir, '_videos');
  const viewport = launchPlan.viewport;
  const storageStatePath = driverConfig.storageState
    ? path.resolve(driverConfig.storageState)
    : undefined;

  if (storageStatePath && !fs.existsSync(storageStatePath)) {
    console.error(`Error: storage state file not found: ${storageStatePath}`);
    process.exit(1);
  }

  if (launchPlan.walletMode && browserName !== 'chromium') {
    console.error('Error: wallet mode currently supports Chromium only. Set --browser chromium.');
    process.exit(1);
  }

  // Set up browser
  let browser: Awaited<ReturnType<typeof chromium.launch>> | Awaited<ReturnType<typeof firefox.launch>> | Awaited<ReturnType<typeof webkit.launch>> | undefined;
  let persistentContext: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  let stopWalletAutoApprover: (() => void) | undefined;

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
    await applyStorageStateToPersistentContext(persistentContext, storageStatePath);

    const walletConfig = driverConfig.wallet ?? {};
    const shouldAutoApprove = walletConfig.autoApprove ?? true;
    if (shouldAutoApprove) {
      stopWalletAutoApprover = await startWalletAutoApprover(persistentContext, {
        password: walletConfig.password,
        tickMs: walletConfig.tickMs,
        actionSelectors: walletConfig.actionSelectors,
      });
    }

    const preflightEnabled = walletConfig.preflight?.enabled ?? true;
    const preflightSeedUrls =
      walletConfig.preflight?.seedUrls && walletConfig.preflight.seedUrls.length > 0
        ? walletConfig.preflight.seedUrls
        : [...new Set(cases.map((testCase) => testCase.startUrl).filter(Boolean))];

    if (preflightEnabled && preflightSeedUrls.length > 0) {
      const preflight = await runWalletPreflight(persistentContext, {
        seedUrls: preflightSeedUrls,
        password: walletConfig.password,
        actionSelectors: walletConfig.actionSelectors,
        promptPaths: walletConfig.promptPaths,
        connectSelectors: walletConfig.connectSelectors,
        connectorSelectors: walletConfig.connectorSelectors,
        requestAccounts: walletConfig.preflight?.requestAccounts,
        accountsTimeoutMs: walletConfig.preflight?.accountsTimeoutMs,
        maxChainSwitchAttempts: walletConfig.preflight?.maxChainSwitchAttempts,
        chain: walletConfig.preflight?.chain,
        log: quiet ? undefined : (message) => console.log(`[wallet] ${message}`),
      });

      if (!preflight.ok) {
        const failed = preflight.results.find((resultEntry) => !resultEntry.ready);
        const details = failed?.details ?? 'unknown reason';
        throw new Error(
          `Wallet preflight failed for ${preflight.failedUrl ?? 'unknown origin'} (${details})`,
        );
      }
    }
  } else {
    const browserType = browserName === 'firefox'
      ? firefox
      : browserName === 'webkit'
        ? webkit
        : chromium;

    browser = await browserType.launch({
      headless: launchPlan.headless,
      ...(browserName === 'chromium' ? { args: launchPlan.browserArgs } : {}),
    });
  }

  const driverFactory = async () => {
    const context = persistentContext ?? await browser!.newContext({
      viewport,
      recordVideo: { dir: videoDir, size: viewport },
      storageState: storageStatePath,
    });
    const page = await context.newPage();
    const driver = new PlaywrightDriver(page, {
      captureScreenshots: config.vision,
      screenshotQuality: 50,
      disableCdp: driverConfig.disableCdp,
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
        await driver.close().catch(() => {});
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
    enableMemory: driverConfig.memory?.enabled === true,
    trajectoryStorePath: driverConfig.memory?.dir,
    concurrency,
    screenshotInterval,
    artifactSink: sink,
    onProgress: (event) => {
      if (values.json) {
        console.log(JSON.stringify(event));
        return;
      }
      if (quiet) return;
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

  let result: import('./types.js').TestSuiteResult | undefined;
  let runError: unknown;

  try {
    result = await runner.runSuite(cases);

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
        if (!quiet && !values.json) {
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
  } catch (err) {
    runError = err;
  } finally {
    await singleDriver?.close?.().catch(() => {});
    stopWalletAutoApprover?.();
    await persistentContext?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }

  if (runError) {
    throw runError;
  }

  await syncLocalBenchmarkRun(path.resolve(sinkDir), values.cases
    ? `${path.basename(values.cases)} · cli run`
    : `${values.goal!.slice(0, 80)} · cli run`);

  process.exit((result?.summary.failed ?? 1) > 0 ? 1 : 0);
}

function printHelp(): void {
  console.log(`
agent-driver — LLM-driven browser automation CLI

USAGE:
  agent-driver run [options]

SINGLE TASK:
  agent-driver run --goal "Sign up for account" --url http://localhost:3000
  agent-driver run -g "Build a todo app" -u http://localhost:5173 -m claude-sonnet-4-20250514
  agent-driver run --goal "Create Coinbase blueprint and verify preview" --url https://ai.tangle.tools --persona alice-blueprint-builder
  agent-driver run --goal "Create partner project and verify preview works" --url https://ai.tangle.tools --persona auto
  agent-driver run --goal "Explore key routes quickly" --url https://example.com --mode fast-explore

TEST SUITE:
  agent-driver run --cases ./cases.json --concurrency 4
  agent-driver run --cases ./cases.json --sink ./results/ --model gpt-5.2

DOCKER:
  docker run -v ./cases.json:/data/cases.json -v ./out:/output \\
    agent-driver run --cases /data/cases.json --sink /output/

OPTIONS:
      --config <path>         Path to config file (default: auto-detect)
  -g, --goal <text>           Natural language goal for single task
  -u, --url <url>             Starting URL
  -c, --cases <file>          JSON file with test cases array
  -m, --model <name>          LLM model (default: gpt-5.2)
      --provider <name>       LLM provider: openai, anthropic, google, codex-cli, claude-code (default: openai)
      --model-adaptive        Enable adaptive model routing for decide() turns
      --nav-model <name>      Fast navigation model for adaptive routing
      --nav-provider <name>   Provider for nav model (default: same as --provider)
      --persona <id>          Append persona directive (${listPersonaIds().join(', ')})
      --mode <name>           Mode preset: ${RUN_MODES.join(', ')}
      --profile <name>        Execution profile: ${DRIVER_PROFILES.join(', ')}
      --prompt-file <path>    Load system prompt from file for experimentable prompt variants
      --api-key <key>         API key (or set OPENAI_API_KEY / ANTHROPIC_API_KEY; codex-cli can use \`codex login\`; claude-code can use \`claude login\`)
      --base-url <url>        Custom LLM endpoint (e.g., LiteLLM proxy)
      --browser <name>        Browser: chromium, firefox, webkit (default: chromium)
      --storage-state <file>  Playwright storage state JSON for pre-authenticated session
      --concurrency <n>       Parallel workers (default: 1)
      --max-turns <n>         Max turns per test (default: 30)
      --llm-timeout <ms>      Timeout per LLM call in milliseconds
      --retries <n>           Retries for observe/LLM/action transient failures
      --retry-delay-ms <ms>   Base retry backoff in milliseconds
      --screenshot-interval <n>  Capture every N turns (default: 5)
      --headless              Run browser headless (default: true)
      --no-headless           Show browser window
      --wallet               Enable wallet mode (persistent Chromium profile)
      --extension <path>     Load unpacked wallet/browser extension (repeatable)
      --user-data-dir <dir>  Persistent profile directory for wallet sessions
      --wallet-auto-approve  Enable extension prompt auto-approval (default: true in wallet mode)
      --wallet-password <v>  Wallet unlock password for auto-approval/preflight
      --wallet-preflight     Run wallet origin preflight before tests (default: true in wallet mode)
      --wallet-seed-url <u>  Preflight URL to authorize/switch-chain (repeatable)
      --wallet-chain-id <n>  Target chain ID for preflight switch/add
      --wallet-chain-rpc-url <u>  RPC URL for preflight wallet_addEthereumChain
      --memory               Enable trajectory memory reuse
      --memory-dir <dir>     Memory directory (default: .agent-memory)
      --timeout <ms>          Per-test timeout in ms (default: 600000)
  -s, --sink <dir>            Output directory for artifacts (default: ./agent-results)
      --json                  Output progress as JSON lines (for piping)
  -q, --quiet                 Suppress all output
      --quality-threshold <n> Min quality score 1-10 (default: 0 = skip)
      --trace-scoring         Enable trajectory scoring for reference trace selection
      --trace-ttl-days <n>    Retention window for scored traces (default: 30)
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
  CODEX_CLI_PATH       Optional Codex CLI binary path for --provider codex-cli
  CODEX_ALLOW_NPX      Set to 0 to disable npx fallback for --provider codex-cli
  CLAUDE_CODE_CLI_PATH Optional Claude CLI binary path for --provider claude-code
`);
}

function resolveProviderApiKey(
  provider: 'openai' | 'anthropic' | 'google' | 'codex-cli' | 'claude-code',
  explicitApiKey?: string,
): string | undefined {
  if (explicitApiKey) return explicitApiKey;

  if (provider === 'anthropic' || provider === 'claude-code') {
    return process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY;
  }

  if (provider === 'google') {
    return process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY;
  }

  if (provider === 'codex-cli') {
    return process.env.OPENAI_API_KEY;
  }

  return process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;
}

async function syncLocalBenchmarkRun(outPath: string, label: string): Promise<void> {
  if (process.env.ABD_BENCHMARK_SYNC === '0') return;
  const importerPath = path.resolve(
    path.join(new URL('.', import.meta.url).pathname, '..', '..', 'abd-app', 'worker', 'scripts', 'import-local-benchmarks.mjs'),
  );
  if (!fs.existsSync(importerPath)) return;
  if (!fs.existsSync(outPath)) return;

  const args = [importerPath, '--path', outPath, '--label', label];
  const userEmail = process.env.ABD_BENCHMARK_USER_EMAIL;
  if (userEmail) args.push('--user-email', userEmail);

  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn('node', args, {
      cwd: path.dirname(importerPath),
      env: {
        ...process.env,
        ABD_BENCHMARK_SYNC: '0',
      },
      stdio: 'inherit',
    });
    child.once('error', () => resolve(1));
    child.once('close', (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    if (process.env.ABD_BENCHMARK_SYNC_STRICT === '1') {
      throw new Error(`abd-app benchmark import failed for ${outPath}`);
    }
    console.warn(`abd-app benchmark import skipped after non-zero exit for ${outPath}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
