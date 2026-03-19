#!/usr/bin/env node

/**
 * CLI for browser-agent-driver — run agent test cases from the command line.
 *
 * Usage:
 *   bad run --goal "Sign up" --url http://localhost:3000
 *   bad run --cases ./cases.json --concurrency 4
 *   bad run --cases ./cases.json --sink ./results/ --model claude-sonnet-4-20250514
 *
 * Designed for sandbox/container execution:
 *   docker run bad run --cases /data/cases.json --sink /output/
 */

import { parseArgs } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { BrowserContext, Route } from 'playwright';
import { loadConfig, mergeConfig, toAgentConfig } from './config.js';
import type { DriverConfig } from './config.js';
import { buildBrowserLaunchPlan } from './browser-launch.js';
import { runWalletPreflight, startWalletAutoApprover } from './wallet/automation.js';
import { isPersonaId, listPersonaIds, withPersonaDirective } from './personas.js';
import { resolveProviderApiKey, resolveProviderModelName } from './provider-defaults.js';
import { loadLocalEnvFiles } from './env-loader.js';
import { CliRenderer, cliError, cliWarn, cliLog, printStyledHelp } from './cli-ui.js';
import { ProjectStore } from './memory/project-store.js';
import { RunRegistry } from './memory/run-registry.js';

type RunMode = 'fast-explore' | 'full-evidence';
const RUN_MODES: RunMode[] = ['fast-explore', 'full-evidence'];
type DriverProfile = NonNullable<DriverConfig['profile']>;
const DRIVER_PROFILES: DriverProfile[] = ['default', 'stealth', 'benchmark-webbench', 'benchmark-webbench-stealth', 'benchmark-webvoyager'];

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
      timeout: { type: 'string' },
      extension: { type: 'string', multiple: true },
      'user-data-dir': { type: 'string' },
      'profile-dir': { type: 'string' },
      'cdp-url': { type: 'string' },
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
    printStyledHelp(RUN_MODES, DRIVER_PROFILES, listPersonaIds());
    process.exit(0);
  }

  const command = positionals[0];

  if (command === 'design-audit') {
    if (!values.url) {
      cliError('--url is required for design-audit.');
      process.exit(1);
    }

    // --design-compare mode
    if (values['design-compare']) {
      if (!values['compare-url']) {
        cliError('--compare-url is required with --design-compare.');
        process.exit(1);
      }
      const { runDesignCompare } = await import('./design/compare.js');
      await runDesignCompare({
        urlA: values.url,
        urlB: values['compare-url'],
        headless: values.headless,
        outputDir: values.sink,
      });
      process.exit(0);
    }

    // --rip mode
    if (values.rip) {
      const { ripSite } = await import('./design/rip.js');
      await ripSite({
        url: values.url,
        pages: values.pages ? parseInt(values.pages) : undefined,
        headless: values.headless,
        outputDir: values.sink,
      });
      process.exit(0);
    }

    const { runDesignAudit } = await import('./cli-design-audit.js');
    await runDesignAudit({
      url: values.url,
      pages: values.pages ? parseInt(values.pages) : undefined,
      profile: values.profile,
      model: values.model,
      provider: values.provider,
      apiKey: values['api-key'],
      output: values.sink,
      json: values.json,
      headless: values.headless,
      debug: values.debug,
      extractTokens: values['extract-tokens'],
    });
    process.exit(0);
  }

  if (command === 'runs') {
    const store = new ProjectStore(values['memory-dir'])
    const registry = new RunRegistry(store.getRoot())
    const runs = registry.listRuns({
      domain: values.url ? new URL(values.url).hostname : undefined,
      sessionId: values['session-id'],
      limit: 20,
    })
    if (runs.length === 0) {
      console.log('  No runs found.')
    } else if (values.json) {
      console.log(JSON.stringify(runs, null, 2))
    } else {
      for (const r of runs) {
        const icon = r.status === 'completed' ? (r.success ? '\u2713' : '\u2717') : '\u25cb'
        const ts = r.startedAt.slice(0, 16).replace('T', ' ')
        const dur = r.completedAt
          ? `${Math.round((new Date(r.completedAt).getTime() - new Date(r.startedAt).getTime()) / 1000)}s`
          : 'running'
        const session = r.sessionId ? ` [${r.sessionId}]` : ''
        const parent = r.parentRunId ? ` \u2190 ${r.parentRunId.slice(0, 20)}` : ''
        console.log(`  ${icon} ${r.runId.slice(0, 30)}  ${ts}  ${dur}  ${r.goal.slice(0, 50)}${session}${parent}`)
        if (r.summary) console.log(`    ${r.summary.slice(0, 80)}`)
        if (r.finalUrl) console.log(`    ${r.finalUrl}`)
      }
    }
    process.exit(0)
  }

  if (command === 'showcase') {
    const { handleShowcase } = await import('./cli-showcase.js');
    await handleShowcase({
      url: values.url,
      script: values.script,
      capture: values.capture,
      crop: values.crop,
      highlight: values.highlight,
      format: values.format,
      viewport: values.viewport,
      output: values.sink,
      headless: values.headless ?? true,
      colorScheme: values['color-scheme'] as 'dark' | 'light' | undefined,
      scale: values.scale ? parseFloat(values.scale) : undefined,
      storageState: values['storage-state'],
      quality: values['quality-threshold'] ? parseInt(values['quality-threshold']) : undefined,
    });
    process.exit(0);
  }

  if (command === 'auth') {
    const sub = positionals[1];
    if (sub === 'save') {
      const { handleAuthSave } = await import('./cli-auth.js');
      await handleAuthSave({
        url: values.url || positionals[2],
        output: values['storage-state'] || positionals[3],
      });
      process.exit(0);
    }
    if (sub === 'login') {
      const { handleAuthLogin } = await import('./cli-auth.js');
      await handleAuthLogin({
        url: values.url || positionals[2],
        output: values['storage-state'],
        fill: values.fill,
        cookie: values.cookie,
        waitFor: values['wait-for'],
        waitTimeout: values['wait-timeout'] ? parseInt(values['wait-timeout'], 10) : undefined,
        headless: values.headless,
      });
      process.exit(0);
    }
    if (sub === 'check') {
      const { handleAuthCheck } = await import('./cli-auth.js');
      await handleAuthCheck({
        path: values['storage-state'] || positionals[2],
        origin: positionals[3],
      });
      process.exit(0);
    }
    cliError(`Unknown auth subcommand: ${sub || '(none)'}. Use "auth save", "auth login", or "auth check".`);
    process.exit(1);
  }

  if (command !== 'run') {
    cliError(`Unknown command: ${command}. Use "run", "runs", "design-audit", "showcase", or "auth".`);
    process.exit(1);
  }

  // Validate inputs
  if (!values.goal && !values.cases && !values['resume-run'] && !values['fork-run']) {
    cliError('provide --goal "..." --url "..." for a single task, --cases ./cases.json for a suite, or --resume-run / --fork-run <runId>.');
    process.exit(1);
  }

  // Load config file, then overlay CLI flags
  const fileConfig = await loadConfig(values.config);

  const mode = values.mode;
  if (mode && !RUN_MODES.includes(mode as RunMode)) {
    cliError(`unknown mode "${mode}". Valid modes: ${RUN_MODES.join(', ')}`);
    process.exit(1);
  }

  const profile = values.profile;
  if (profile && !DRIVER_PROFILES.includes(profile as DriverProfile)) {
    cliError(`unknown profile "${profile}". Valid profiles: ${DRIVER_PROFILES.join(', ')}`);
    process.exit(1);
  }

  // Build CLI overrides (only set values that were explicitly passed)
  const cliOverrides: Partial<DriverConfig> = {};
  if (values.model) cliOverrides.model = values.model;
  if (values.provider) cliOverrides.provider = values.provider as DriverConfig['provider'];
  if (values['model-adaptive'] !== undefined) cliOverrides.adaptiveModelRouting = values['model-adaptive'];
  if (values['nav-model']) cliOverrides.navModel = values['nav-model'];
  if (values['nav-provider']) cliOverrides.navProvider = values['nav-provider'] as DriverConfig['navProvider'];
  if (values['sandbox-backend-type']) cliOverrides.sandboxBackendType = values['sandbox-backend-type'];
  if (values['sandbox-backend-profile']) cliOverrides.sandboxBackendProfile = values['sandbox-backend-profile'];
  if (values['sandbox-backend-provider']) cliOverrides.sandboxBackendProvider = values['sandbox-backend-provider'];
  if (values['api-key']) cliOverrides.apiKey = values['api-key'];
  if (values['base-url']) cliOverrides.baseUrl = values['base-url'];
  if (values['prompt-file']) {
    const promptPath = path.resolve(values['prompt-file']);
    if (!fs.existsSync(promptPath)) {
      cliError(`prompt file not found: ${promptPath}`);
      process.exit(1);
    }
    cliOverrides.systemPrompt = fs.readFileSync(promptPath, 'utf-8').trim();
    if (!cliOverrides.systemPrompt) {
      cliError(`prompt file is empty: ${promptPath}`);
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
  if (
    values.scout !== undefined ||
    values['scout-model'] ||
    values['scout-provider'] ||
    values['scout-vision'] !== undefined ||
    values['scout-max-candidates'] ||
    values['scout-min-top-score'] ||
    values['scout-max-score-gap']
  ) {
    cliOverrides.scout = {
      ...(cliOverrides.scout ?? {}),
    };
    if (values.scout !== undefined) cliOverrides.scout.enabled = values.scout;
    if (values['scout-model']) cliOverrides.scout.model = values['scout-model'];
    if (values['scout-provider']) {
      cliOverrides.scout.provider = values['scout-provider'] as NonNullable<DriverConfig['scout']>['provider'];
    }
    if (values['scout-vision'] !== undefined) cliOverrides.scout.useVision = values['scout-vision'];
    if (values['scout-max-candidates']) cliOverrides.scout.maxCandidates = parseInt(values['scout-max-candidates'], 10);
    if (values['scout-min-top-score']) cliOverrides.scout.minTopScore = parseInt(values['scout-min-top-score'], 10);
    if (values['scout-max-score-gap']) cliOverrides.scout.maxScoreGap = parseInt(values['scout-max-score-gap'], 10);
  }
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
  if (values['vision-strategy']) cliOverrides.visionStrategy = values['vision-strategy'] as DriverConfig['visionStrategy'];
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
  if (values['profile-dir']) cliOverrides.profileDir = values['profile-dir']
  if (values['cdp-url']) cliOverrides.cdpUrl = values['cdp-url']

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
  } else if (profile === 'benchmark-webbench' || profile === 'benchmark-webbench-stealth') {
    if (!values['llm-timeout']) cliOverrides.llmTimeoutMs = 20_000;
    cliOverrides.compactFirstTurn = true;
    if (!values.retries) cliOverrides.retries = 1;
    if (!values['retry-delay-ms']) cliOverrides.retryDelayMs = 250;
    if (values.vision === undefined) cliOverrides.vision = false;
    if (!values['screenshot-interval']) cliOverrides.screenshotInterval = 0;
    if (values['goal-verification'] === undefined) cliOverrides.goalVerification = true;
    if (profile === 'benchmark-webbench-stealth' && values.headless === undefined) {
      cliOverrides.headless = false;
    }
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
      cliWarn(warning);
    }
  }

  if (launchPlan.errors.length > 0) {
    for (const error of launchPlan.errors) {
      cliError(error);
    }
    process.exit(1);
  }

  // Dynamic imports — keeps startup fast and allows tree-shaking.
  // Use patchright (Playwright fork with CDP leak fixes) for stealth profiles
  // to avoid Cloudflare/DataDome detection via Runtime.enable.
  const isStealthProfile = launchPlan.profile.includes('stealth');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { chromium, firefox, webkit } = (isStealthProfile
    ? await import('patchright')
    : await import('playwright')) as any;
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
  const resolvedModel = resolveProviderModelName(resolvedProvider, driverConfig.model, {
    sandboxBackendType: resolvedProvider === 'sandbox-backend' ? driverConfig.sandboxBackendType : undefined,
  });
  const resolvedNavProvider = driverConfig.navProvider || resolvedProvider;
  const resolvedNavModel = driverConfig.navModel
    ? resolveProviderModelName(resolvedNavProvider, driverConfig.navModel, {
        sandboxBackendType: resolvedNavProvider === 'sandbox-backend' ? driverConfig.sandboxBackendType : undefined,
      })
    : undefined;
  const resolvedSupervisorProvider = driverConfig.supervisor?.provider || resolvedProvider;
  const resolvedSupervisorModel = resolveProviderModelName(
    resolvedSupervisorProvider,
    driverConfig.supervisor?.model || resolvedModel,
    {
      sandboxBackendType: resolvedSupervisorProvider === 'sandbox-backend' ? driverConfig.sandboxBackendType : undefined,
    },
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
    walletMode: Boolean(driverConfig.wallet?.enabled),
    walletAddress: driverConfig.wallet?.address,
  };

  // Create project store for memory + run registry
  const memoryEnabled = driverConfig.memory?.enabled === true
  const projectStore = memoryEnabled
    ? new ProjectStore(driverConfig.memory?.dir)
    : undefined
  const runRegistry = projectStore
    ? new RunRegistry(projectStore.getRoot())
    : undefined

  // Build test cases
  let cases: import('./types.js').TestCase[];

  if (values['resume-run'] || values['fork-run']) {
    // Resume or fork from a previous run
    if (!runRegistry) {
      cliError('--resume-run and --fork-run require memory to be enabled')
      process.exit(1)
    }
    const isResume = Boolean(values['resume-run'])
    const sourceRunId = (values['resume-run'] || values['fork-run'])!
    const scenario = isResume
      ? runRegistry.buildResumeScenario(sourceRunId, values.goal)
      : runRegistry.buildForkScenario(sourceRunId, values.goal || '')

    if (!scenario) {
      cliError(`run "${sourceRunId}" not found in registry`)
      process.exit(1)
    }
    if (!isResume && !values.goal) {
      cliError('--fork-run requires --goal')
      process.exit(1)
    }

    cases = [{
      id: `${isResume ? 'resume' : 'fork'}-${sourceRunId.slice(0, 20)}`,
      name: scenario.goal.slice(0, 60),
      startUrl: values.url || scenario.startUrl,
      goal: scenario.goal,
      allowedDomains: parseAllowedDomains(values['allowed-domains']),
      maxTurns,
      timeoutMs,
      priority: 0,
      sessionId: scenario.sessionId,
      parentRunId: scenario.parentRunId,
    }]
  } else if (values.cases) {
    const raw = fs.readFileSync(path.resolve(values.cases), 'utf-8');
    const parsed = JSON.parse(raw);
    const rawCases: Record<string, unknown>[] = Array.isArray(parsed) ? parsed : [parsed];
    // Ensure required fields — spread raw case first so explicit fields become defaults
    cases = rawCases.map((c, i) => ({
      id: (c.id as string) || `case-${i}`,
      name: (c.name as string) || (c.goal as string)?.slice(0, 60) || `Case ${i}`,
      startUrl: (c.startUrl as string) || (c.url as string) || values.url || '',
      goal: (c.goal as string) || '',
      allowedDomains: Array.isArray(c.allowedDomains)
        ? c.allowedDomains.filter((domain): domain is string => typeof domain === 'string' && domain.length > 0)
        : parseAllowedDomains(values['allowed-domains']),
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
      allowedDomains: parseAllowedDomains(values['allowed-domains']),
      maxTurns,
      timeoutMs,
      priority: 0,
      sessionId: values['session-id'],
    }];
  }

  // Apply --session-id to all cases from file too
  if (values['session-id'] && cases.length > 0 && cases[0].id !== 'cli-task') {
    const sid = values['session-id']
    cases = cases.map(c => ({ ...c, sessionId: c.sessionId || sid }))
  }

  const persona = values.persona;
  if (persona) {
    if (!isPersonaId(persona)) {
      cliError(`unknown persona "${persona}". Valid personas: ${listPersonaIds().join(', ')}`);
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

  const renderer = (!quiet && !values.json) ? new CliRenderer({ debug }) : null;
  if (renderer) {
    const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8')).version;
    renderer.banner({
      version,
      provider: config.provider || 'openai',
      model: config.model,
      browser: browserName,
      testCount: cases.length,
      concurrency,
      mode: mode || undefined,
      profile: driverConfig.profile,
      adaptiveRouting: config.adaptiveModelRouting ? {
        navProvider: config.navProvider || config.provider || 'openai',
        navModel: config.navModel || 'gpt-4.1-mini',
      } : undefined,
      outputDir: sinkDir,
    });
  }

  // Set up artifact sink
  const sink = new FilesystemSink(path.resolve(sinkDir));
  const videoDir = path.join(sinkDir, '_videos');
  const viewport = launchPlan.viewport;
  const storageStatePath = driverConfig.storageState
    ? path.resolve(driverConfig.storageState)
    : undefined;

  if (storageStatePath && !fs.existsSync(storageStatePath)) {
    cliError(`storage state file not found: ${storageStatePath}`);
    process.exit(1);
  }

  if (launchPlan.persistentContext && !launchPlan.cdpUrl && browserName !== 'chromium') {
    const feature = launchPlan.walletMode ? 'Wallet mode' : '--profile-dir'
    throw new Error(`${feature} requires Chromium. Set --browser chromium.`)
  }

  // Ensure clean exit on interrupt
  process.on('SIGINT', () => { renderer?.destroy(); process.exit(130); });
  process.on('SIGTERM', () => { renderer?.destroy(); process.exit(143); });

  renderer?.launchStart(browserName);

  // Set up browser
  let browser: Awaited<ReturnType<typeof chromium.launch>> | Awaited<ReturnType<typeof firefox.launch>> | Awaited<ReturnType<typeof webkit.launch>> | undefined;
  let persistentContext: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  let stopWalletAutoApprover: (() => void) | undefined;
  const launchDiagnostics: Record<string, number | string | boolean> = {};

  // CDP connection — attach to an existing browser (Atlas, Chrome, Brave, etc.)
  let cdpUrl = launchPlan.cdpUrl || process.env.BROWSER_ENDPOINT
  let cdpConnected = false
  if (cdpUrl) {
    // Auto-discover WebSocket URL from HTTP endpoint
    if (cdpUrl.startsWith('http://') || cdpUrl.startsWith('https://')) {
      try {
        const versionUrl = cdpUrl.replace(/\/$/, '') + '/json/version'
        const res = await fetch(versionUrl)
        const info = await res.json() as { webSocketDebuggerUrl?: string; Browser?: string }
        if (info.webSocketDebuggerUrl) {
          if (info.Browser && !quiet) cliLog('cdp', `connected to ${info.Browser}`)
          cdpUrl = info.webSocketDebuggerUrl
        }
      } catch {
        // Fall through — try the URL as-is
      }
    }
    const cdpStartedAt = Date.now()
    if (cdpUrl.includes('/devtools/') || browserName === 'chromium') {
      browser = await chromium.connectOverCDP(cdpUrl)
    } else {
      const browserType = browserName === 'firefox' ? firefox : browserName === 'webkit' ? webkit : chromium
      browser = await browserType.connect(cdpUrl)
    }
    launchDiagnostics.browserLaunchMs = Date.now() - cdpStartedAt
    launchDiagnostics.cdpUrl = cdpUrl
    cdpConnected = true
  } else if (launchPlan.persistentContext) {
    for (const extensionPath of launchPlan.extensionPaths) {
      if (!fs.existsSync(extensionPath)) {
        throw new Error(`Wallet extension path does not exist: ${extensionPath}`);
      }
    }

    const userDataDir = launchPlan.userDataDir ?? path.resolve(launchPlan.walletMode ? '.agent-wallet-profile' : '.agent-profile');
    fs.mkdirSync(userDataDir, { recursive: true });

    const persistentLaunchStartedAt = Date.now();
    persistentContext = await chromium.launchPersistentContext(userDataDir, {
      channel: isStealthProfile ? 'chrome' : 'chromium',
      headless: launchPlan.headless,
      args: launchPlan.browserArgs,
      viewport,
      recordVideo: { dir: videoDir, size: viewport },
    });
    launchDiagnostics.browserLaunchMs = Date.now() - persistentLaunchStartedAt;
    await applyStorageStateToPersistentContext(persistentContext, storageStatePath);

    if (launchPlan.walletMode) {
      const walletConfig = driverConfig.wallet ?? {};

      // Intercept page-level JSON-RPC so dApps see wallet balances from the
      // local Anvil fork. Only forward user-specific calls (eth_getBalance
      // for the wallet, eth_call with wallet address in calldata). Pool data
      // and protocol calls go to real endpoints for reliability.
      const walletRpcUrl = walletConfig.preflight?.chain?.rpcUrl;
      if (walletRpcUrl) {
        // Default to Anvil's first derived address if no wallet address configured
        const walletAddrFull = (walletConfig.address ?? '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266').toLowerCase()
        const walletAddrHex = walletAddrFull.replace('0x', '')
        await persistentContext.route('**/*', async (route: Route) => {
          try {
            const frame = route.request().frame()
            if (frame && frame.url().startsWith('chrome-extension://')) { await route.continue(); return }
          } catch {
            await route.continue()
            return
          }
          if (route.request().method() !== 'POST') { await route.continue(); return }
          const ct = route.request().headers()['content-type'] ?? ''
          if (!ct.includes('json')) { await route.continue(); return }
          const postData = route.request().postData()
          if (!postData) { await route.continue(); return }
          try {
            const body = JSON.parse(postData)
            const items: Record<string, unknown>[] = Array.isArray(body) ? body : [body]
            // Check if any item involves the wallet (balance, contract call, simulation)
            const isUserQuery = items.some((item) => {
              const method = item.method as string | undefined
              if (!method) return false
              if (method === 'eth_getBalance') {
                const params = item.params as string[] | undefined
                return params?.[0]?.toLowerCase() === walletAddrFull
              }
              if (method === 'eth_call' || method === 'eth_estimateGas') {
                const params = item.params as Record<string, string>[] | undefined
                const txObj = params?.[0]
                if (!txObj) return false
                const from = txObj.from?.toLowerCase() ?? ''
                const data = txObj.data?.toLowerCase() ?? ''
                return from === walletAddrFull || data.includes(walletAddrHex)
              }
              if (method === 'eth_getTransactionCount') {
                const params = item.params as string[] | undefined
                return params?.[0]?.toLowerCase() === walletAddrFull
              }
              return false
            })
            if (!isUserQuery) { await route.continue(); return }
            // Normalize: some dApps (Aave) omit jsonrpc/id — Anvil requires them
            let nextId = 1
            const normalized = items.map((item) => {
              const out: Record<string, unknown> = { ...item, jsonrpc: '2.0', id: item.id ?? nextId++ }
              delete out.chainId
              return out
            })
            const payload = Array.isArray(body) ? normalized : normalized[0]
            const res = await fetch(walletRpcUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            })
            await route.fulfill({
              status: res.status,
              contentType: 'application/json',
              body: await res.text(),
            })
          } catch { await route.continue() }
        })
      }

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
          log: quiet ? undefined : (message) => cliLog('wallet', message),
        });

        if (!preflight.ok) {
          const failed = preflight.results.find((resultEntry) => !resultEntry.ready);
          const details = failed?.details ?? 'unknown reason';
          throw new Error(
            `Wallet preflight failed for ${preflight.failedUrl ?? 'unknown origin'} (${details})`,
          );
        }
      }
    }
  } else {
    const browserType = browserName === 'firefox'
      ? firefox
      : browserName === 'webkit'
        ? webkit
        : chromium

    const browserLaunchStartedAt = Date.now()
    browser = await browserType.launch({
      headless: launchPlan.headless,
      ...(browserName === 'chromium' ? { args: launchPlan.browserArgs } : {}),
      // Use system Chrome for stealth profiles — real TLS/JA3 fingerprint vs bundled Chromium
      ...(isStealthProfile && browserName === 'chromium' ? { channel: 'chrome' } : {}),
    })
    launchDiagnostics.browserLaunchMs = Date.now() - browserLaunchStartedAt
  }

  // Headless Chromium sends "HeadlessChrome/..." in the default User-Agent.
  // CDNs like Akamai reject this with ERR_HTTP2_PROTOCOL_ERROR before any JS
  // stealth patches can run. Build a clean UA from the browser version.
  const headlessUserAgent = launchPlan.headless && browser
    ? (() => {
        const ver = browser.version()
        const plat = process.platform
        const platformToken = plat === 'win32'
          ? 'Windows NT 10.0; Win64; x64'
          : plat === 'linux'
            ? 'X11; Linux x86_64'
            : 'Macintosh; Intel Mac OS X 10_15_7'
        return `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Safari/537.36`
      })()
    : undefined

  const driverFactory = async () => {
    const contextStartedAt = Date.now();

    // CDP: reuse the browser's default context (preserves user cookies/sessions).
    // Persistent context: use the already-opened persistent context.
    // Default: create a fresh isolated context.
    let context: BrowserContext
    if (cdpConnected) {
      // Reuse the user's existing browser context — cookies, localStorage, extensions intact
      const contexts = browser!.contexts()
      context = contexts[0] ?? await browser!.newContext({ viewport })
    } else if (persistentContext) {
      context = persistentContext
    } else {
      context = await browser!.newContext({
        viewport,
        recordVideo: { dir: videoDir, size: viewport },
        storageState: storageStatePath,
        locale: 'en-US',
        timezoneId: 'America/New_York',
        ...(headlessUserAgent ? { userAgent: headlessUserAgent } : {}),
        extraHTTPHeaders: {
          'Accept-Language': 'en-US,en;q=0.9',
        },
      })
    }

    // Stealth patches: only for Playwright-controlled contexts (not real user browsers)
    if (!cdpConnected) {
      await context.addInitScript(`
        // navigator.webdriver — explicit override (backup for --disable-blink-features)
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        // navigator.plugins — empty in headless, non-empty in real browsers
        Object.defineProperty(navigator, 'plugins', {
          get: () => [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
            { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
          ],
        });
        // navigator.languages — must match Accept-Language header
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        // hardware signals — realistic desktop values
        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
        Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
        // window.chrome — full stub matching real Chrome
        if (!window.chrome) window.chrome = {};
        if (!window.chrome.runtime) window.chrome.runtime = { id: undefined };
        if (!window.chrome.app) window.chrome.app = { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } };
        if (!window.chrome.csi) window.chrome.csi = function() { return { onloadT: Date.now(), startE: Date.now(), pageT: Date.now() - performance.timing.navigationStart }; };
        if (!window.chrome.loadTimes) window.chrome.loadTimes = function() { return { commitLoadTime: Date.now() / 1000, connectionInfo: 'h2', finishDocumentLoadTime: Date.now() / 1000, finishLoadTime: Date.now() / 1000, firstPaintAfterLoadTime: 0, firstPaintTime: Date.now() / 1000, navigationType: 'Other', npnNegotiatedProtocol: 'h2', requestTime: Date.now() / 1000 - 0.16, startLoadTime: Date.now() / 1000 - 0.16, wasAlternateProtocolAvailable: false, wasFetchedViaSpdy: true, wasNpnNegotiated: true }; };
        // WebGL vendor/renderer — match real GPU values
        try {
          const getParameter = WebGLRenderingContext.prototype.getParameter;
          WebGLRenderingContext.prototype.getParameter = function(parameter) {
            if (parameter === 37445) return 'Intel Inc.';
            if (parameter === 37446) return 'Intel Iris OpenGL Engine';
            return getParameter.call(this, parameter);
          };
        } catch (_) {}
        try {
          const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
          WebGL2RenderingContext.prototype.getParameter = function(parameter) {
            if (parameter === 37445) return 'Intel Inc.';
            if (parameter === 37446) return 'Intel Iris OpenGL Engine';
            return getParameter2.call(this, parameter);
          };
        } catch (_) {}
        // window.outerWidth/outerHeight — 0 in headless, match viewport in real browsers
        if (window.outerWidth === 0) Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth });
        if (window.outerHeight === 0) Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + 85 });
        // Patch permissions API — cover all permission types bots commonly mis-handle
        try {
          const origQuery = navigator.permissions.query.bind(navigator.permissions);
          navigator.permissions.query = (params) => {
            const deny = ['notifications', 'geolocation', 'camera', 'microphone', 'payment-handler'];
            if (deny.includes(params.name))
              return Promise.resolve({ state: 'denied', onchange: null });
            return origQuery(params);
          };
        } catch (_) {}
        // Canvas fingerprint noise — add imperceptible per-session noise to canvas readback
        // so each session produces a unique fingerprint (defeats static fingerprint matching)
        try {
          const seed = Math.random() * 0xffff | 0;
          const noisify = (canvas) => {
            try {
              const ctx = canvas.getContext('2d');
              if (!ctx) return;
              const { width: w, height: h } = canvas;
              if (w === 0 || h === 0) return;
              const img = ctx.getImageData(0, 0, w, h);
              const d = img.data;
              for (let i = 0; i < d.length; i += 4) {
                // deterministic per-pixel noise from seed + position
                d[i] = d[i] ^ ((seed + i) & 1);
              }
              ctx.putImageData(img, 0, 0);
            } catch (_) {}
          };
          const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
          HTMLCanvasElement.prototype.toDataURL = function(...args) {
            noisify(this);
            return origToDataURL.apply(this, args);
          };
          const origToBlob = HTMLCanvasElement.prototype.toBlob;
          HTMLCanvasElement.prototype.toBlob = function(...args) {
            noisify(this);
            return origToBlob.apply(this, args);
          };
        } catch (_) {}
        // Fix CDP screenX/screenY bug — CDP Input.dispatchMouseEvent sets
        // screenX=clientX, screenY=clientY which never happens in real browsers.
        // Cloudflare Turnstile actively checks this. Add a per-session window
        // offset so screenX/screenY are realistic and internally consistent.
        try {
          const winX = Math.floor(Math.random() * 200) + 50;
          const winY = Math.floor(Math.random() * 100) + 50;
          const chrome = 85;
          Object.defineProperty(MouseEvent.prototype, 'screenX', {
            get() { return this.clientX + winX; },
            configurable: true,
          });
          Object.defineProperty(MouseEvent.prototype, 'screenY', {
            get() { return this.clientY + winY + chrome; },
            configurable: true,
          });
        } catch (_) {}
      `);
    }
    const contextCreateMs = Date.now() - contextStartedAt;
    const pageStartedAt = Date.now();
    const page = await context.newPage();
    const pageCreateMs = Date.now() - pageStartedAt;
    // Cap per-action timeout so one stuck click can't consume the whole case budget.
    // Default 30s is fine for long runs; for short cases (120s) use at most 15s.
    const actionTimeout = Math.min(30_000, Math.max(5_000, Math.floor(timeoutMs / 8)));
    const driver = new PlaywrightDriver(page, {
      captureScreenshots: config.vision,
      screenshotQuality: 50,
      disableCdp: driverConfig.disableCdp,
      timeout: actionTimeout,
      visionStrategy: config.visionStrategy,
      screenshotInterval,
    });
    // Apply resource blocking if configured
    const resourceBlockingStartedAt = Date.now();
    if (driverConfig.resourceBlocking) {
      await driver.setupResourceBlocking(driverConfig.resourceBlocking);
    }
    const resourceBlockingSetupMs = driverConfig.resourceBlocking
      ? Date.now() - resourceBlockingStartedAt
      : 0;
    const diagnostics = {
      browserName,
      headless: launchPlan.headless,
      walletMode: launchPlan.walletMode,
      browserLaunchMs: Number(launchDiagnostics.browserLaunchMs ?? 0),
      contextCreateMs,
      pageCreateMs,
      resourceBlockingSetupMs,
      storageStateApplied: Boolean(storageStatePath) && !cdpConnected,
      persistentContext: Boolean(persistentContext),
      cdpConnected,
    };
    // Wrap in a Driver that properly tears down context on close
    const wrappedDriver: import('./drivers/types.js').Driver = {
      observe: () => driver.observe(),
      execute: (action) => driver.execute(action),
      getPage: () => driver.getPage?.(),
      screenshot: () => driver.screenshot(),
      getDiagnostics: () => diagnostics,
      async close() {
        await driver.close().catch(() => {});
        await page.close().catch(() => {});
        if (!persistentContext && !cdpConnected) {
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

  renderer?.launchDone();

  const runner = new TestRunner({
    config,
    defaultTimeoutMs: timeoutMs,
    driver: singleDriver,
    driverFactory: concurrency > 1 ? driverFactory : undefined,
    enableMemory: memoryEnabled,
    trajectoryStorePath: driverConfig.memory?.dir,
    projectStore,
    concurrency,
    screenshotInterval,
    artifactSink: sink,
    onProgress: (event) => {
      if (values.json) {
        console.log(JSON.stringify(event));
        return;
      }
      if (!renderer) return;
      switch (event.type) {
        case 'suite:start':
          renderer.suiteStart(event.totalTests);
          break;
        case 'test:start':
          renderer.testStart(event.testId, event.testName);
          break;
        case 'test:turn':
          renderer.testTurn(event.testId, event.turn, event.action, event.durationMs, event.modelUsed);
          break;
        case 'test:complete':
          renderer.testComplete(event.testId, event.passed, event.verdict, event.turnsUsed, event.durationMs, event.estimatedCostUsd);
          break;
        case 'suite:complete':
          renderer.suiteComplete(event.passed, event.failed, event.skipped, event.totalMs, event.totalCostUsd, event.manifestUri);
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
        renderer?.report(reportPath);
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
    renderer?.destroy();
    await singleDriver?.close?.().catch(() => {});
    stopWalletAutoApprover?.();
    await persistentContext?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }

  if (runError) {
    throw runError;
  }

  const runLabel = values.cases
    ? `${path.basename(values.cases)} · cli run`
    : `${(values.goal || values['resume-run'] || values['fork-run'] || 'run').slice(0, 80)} · cli run`
  await syncLocalBenchmarkRun(path.resolve(sinkDir), runLabel);

  process.exit((result?.summary.failed ?? 1) > 0 ? 1 : 0);
}

function parseAllowedDomains(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const domains = value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return domains.length > 0 ? [...new Set(domains)] : undefined;
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
    cliWarn(`abd-app benchmark import skipped after non-zero exit for ${outPath}`);
  }
}

main().catch((err) => {
  cliError(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
