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
import { setCliVersion, setInvocation, getTelemetry } from './telemetry/index.js';

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

function readCliVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function main(): Promise<void> {
  loadLocalEnvFiles(process.cwd());
  setCliVersion(readCliVersion());
  setInvocation(process.argv.slice(2)[0] || 'unknown', process.argv.slice(2));

  // Subcommand groups with their own arg shape — dispatch before the strict
  // parent parser (which only knows the run/design-audit/auth/showcase flags).
  const subArgs = process.argv.slice(2);
  if (subArgs[0] === 'jobs') {
    const { runJobsCli } = await import('./cli-jobs.js');
    await runJobsCli(subArgs.slice(1));
    process.exit(0);
  }
  if (subArgs[0] === 'reports') {
    const { runReportsCli } = await import('./cli-reports.js');
    await runReportsCli(subArgs.slice(1));
    process.exit(0);
  }

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

      // Gen 32 — `bad share` flags
      visibility: { type: 'string' },
      'bad-app-url': { type: 'string' },
      'no-copy': { type: 'boolean' },

      // Gen 32 — preview / stream / interrupt
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

  if (command === 'view') {
    const runDir = positionals[1];
    if (!runDir) {
      cliError('usage: bad view <run-directory>');
      process.exit(1);
    }
    const { runViewCli, ViewError } = await import('./cli-view.js');
    try {
      await runViewCli({
        runDir,
        port: values.port ? parseInt(values.port) : undefined,
        noOpen: values['no-open'],
      });
    } catch (err) {
      if (err instanceof ViewError) {
        cliError(err.message);
        process.exit(1);
      }
      throw err;
    }
    return;
  }

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
      baseUrl: values['base-url'],
      output: values.sink,
      json: values.json,
      headless: values.headless,
      debug: values.debug,
      storageState: values['storage-state'],
      extractTokens: values['extract-tokens'],
      evolve: values.evolve,
      evolveRounds: values['evolve-rounds'] ? parseInt(values['evolve-rounds']) : undefined,
      projectDir: values['project-dir'],
      reproducibility: values.reproducibility,
      rubricsDir: values['rubrics-dir'],
      auditPasses: values['audit-passes'],
      skipEthics: values['skip-ethics'],
      ethicsRulesDir: values['ethics-rules-dir'],
      audience: values.audience,
      regulatoryContext: values['regulatory-context'],
      audienceVulnerability: values['audience-vulnerability'],
      modality: values.modality,
    });
    process.exit(0);
  }

  if (command === 'snapshot') {
    if (!values.url) {
      cliError('usage: bad snapshot --url <url> [--json] [--out file.json] [--wait networkidle|load|domcontentloaded|commit] [--timeout <ms>] [--no-dismiss-modals] [--headed]');
      process.exit(2);
    }
    const waitArg = values.wait;
    const wait = waitArg === 'load' || waitArg === 'domcontentloaded' || waitArg === 'networkidle' || waitArg === 'commit'
      ? waitArg
      : undefined;
    const { handleSnapshotCommand } = await import('./cli-snapshot.js');
    const rc = await handleSnapshotCommand({
      url: values.url,
      json: values.json,
      out: values.out,
      timeout: values.timeout ? parseInt(values.timeout, 10) : undefined,
      wait,
      dismissModals: values['dismiss-modals'],
      headed: values.headed,
      debug: values.debug,
    });
    process.exit(rc);
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

  if (command === 'chrome-debug') {
    const { runChromeDebugCommand } = await import('./cli-attach.js')
    const port = values['attach-port'] ? parseInt(values['attach-port'], 10) : undefined
    const rc = await runChromeDebugCommand({
      port,
      userDataDir: values['user-data-dir'],
      quiet: values.quiet,
    })
    process.exit(rc)
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

  // `bad attach` is a top-level alias for `bad run --attach`. Every other
  // flag on `run` (--goal, --url, --model, --provider, --base-url,
  // --api-key, --show-cursor, --mode, --max-turns, --timeout, --no-memory,
  // --attach-port) works identically. Attach's mental model is "drive my
  // real Chrome," which is distinct enough from "spawn a fresh browser"
  // to deserve its own command name.
  if (command === 'attach') {
    values.attach = true;
  }

  // `bad preview` — plan-only dry-run. Observe the URL once, ask the
  // planner to emit a structured plan, render it, exit. No execution.
  // terraform plan for browser agents.
  if (command === 'preview') {
    if (!values.goal || !values.url) {
      cliError('usage: bad preview --goal "..." --url <url> [--max-steps 12] [--headed] [--json] [--out plan.json]');
      process.exit(1);
    }
    const { handlePreviewCommand, PreviewError } = await import('./cli-preview.js');
    try {
      const result = await handlePreviewCommand({
        goal: values.goal,
        url: values.url,
        model: values.model,
        provider: values.provider,
        apiKey: values['api-key'],
        baseUrl: values['base-url'],
        output: values.sink,
        json: values.json,
        maxSteps: values['max-steps'] ? parseInt(values['max-steps'], 10) : undefined,
        headed: values.headed,
      });
      process.exit(result.plan ? 0 : 1);
    } catch (err) {
      if (err instanceof PreviewError) {
        cliError(err.message);
        process.exit(1);
      }
      throw err;
    }
  }

  // `bad share <run-id>` — create a bad-app share link, copy to clipboard.
  if (command === 'share') {
    const runId = positionals[1];
    if (!runId) {
      cliError('usage: bad share <run-id> [--visibility metadata|full|artifacts] [--json]');
      process.exit(1);
    }
    const { handleShareCommand, ShareError } = await import('./cli-share.js');
    const visArg = values.visibility;
    const visibility = visArg === 'full' || visArg === 'artifacts' || visArg === 'metadata'
      ? visArg
      : undefined;
    try {
      await handleShareCommand({
        runId,
        visibility,
        baseUrl: values['bad-app-url'],
        apiKey: values['api-key'],
        noCopy: values['no-copy'],
        json: values.json,
      });
      process.exit(0);
    } catch (err) {
      if (err instanceof ShareError) {
        cliError(err.message);
        process.exit(1);
      }
      throw err;
    }
  }

  if (command !== 'run' && command !== 'attach') {
    cliError(`Unknown command: ${command}. Use "run", "attach", "preview", "runs", "view", "share", "chrome-debug", "design-audit", "showcase", "auth", "jobs", or "reports".`);
    process.exit(1);
  }

  // Validate inputs
  if (!values.goal && !values.cases && !values['cases-json'] && !values['resume-run'] && !values['fork-run']) {
    cliError('provide --goal "..." --url "..." for a single task, --cases ./cases.json (or --cases-json \'[...]\') for a suite, or --resume-run / --fork-run <runId>.');
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
  if (values.proxy) cliOverrides.proxy = values.proxy as string;
  if (values.vision !== undefined) cliOverrides.vision = values.vision;
  if (values['vision-strategy']) cliOverrides.visionStrategy = values['vision-strategy'] as DriverConfig['visionStrategy'];
  if (values['observation-mode']) cliOverrides.observationMode = values['observation-mode'] as DriverConfig['observationMode'];
  if (values['goal-verification'] !== undefined) cliOverrides.goalVerification = values['goal-verification'];
  if (values.planner === true) cliOverrides.plannerEnabled = true;
  if (values['planner-mode']) {
    const plannerMode = values['planner-mode'];
    if (plannerMode !== 'always' && plannerMode !== 'auto') {
      cliError('--planner-mode must be "always" or "auto"')
      process.exit(1)
    }
    cliOverrides.plannerMode = plannerMode;
  }
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

  // --attach resolves to cdpUrl by probing a running Chrome's DevTools
  // endpoint. Done here (pre-config-merge) so the existing cdpUrl path at
  // cli.ts:916 takes over unchanged. Conflicts with wallet/extension/profile
  // flags are surfaced up-front rather than silently ignored.
  if (values.attach) {
    if (values['cdp-url']) {
      cliError('--attach and --cdp-url are mutually exclusive (both select a CDP endpoint). Use one.')
      process.exit(1)
    }
    const { resolveAttachEndpoint, validateAttachConflicts } = await import('./cli-attach.js')
    const conflicts = validateAttachConflicts({
      walletEnabled: Boolean(cliOverrides.wallet?.enabled) || Boolean(values.extension?.length),
      profileDir: values['profile-dir'],
      extensionPaths: values.extension,
      userDataDir: values['user-data-dir'],
    })
    if (!conflicts.ok) {
      for (const err of conflicts.errors) cliError(err)
      process.exit(1)
    }
    const port = values['attach-port'] ? parseInt(values['attach-port'], 10) : undefined
    if (port !== undefined && !Number.isFinite(port)) {
      cliError(`Invalid --attach-port value: ${values['attach-port']}`)
      process.exit(1)
    }
    const info = await resolveAttachEndpoint({ port }).catch((err) => {
      cliError(err instanceof Error ? err.message : String(err))
      process.exit(1)
    })
    cliOverrides.cdpUrl = info.webSocketDebuggerUrl
    if (!values.quiet) cliLog('attach', `connected to ${info.browser ?? 'Chrome'}`)
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

  // Mode presets apply only when equivalent flags were not explicitly set
  // AND the profile didn't already set them. This lets benchmark profiles
  // (e.g. benchmark-webvoyager) enable vision/screenshots without fast-explore
  // clobbering those values.
  if (mode === 'fast-explore') {
    if (values.vision === undefined && cliOverrides.vision === undefined) cliOverrides.vision = false;
    if (!values['screenshot-interval'] && cliOverrides.screenshotInterval === undefined) cliOverrides.screenshotInterval = 0;
    if (values['goal-verification'] === undefined) cliOverrides.goalVerification = true;
    if (values['quality-threshold'] === undefined) cliOverrides.qualityThreshold = 0;
    if (!values['block-analytics'] && !values['block-images'] && !values['block-media']) {
      cliOverrides.resourceBlocking = {
        ...(cliOverrides.resourceBlocking ?? {}),
        blockAnalytics: true,
      };
    }
  } else if (mode === 'full-evidence') {
    if (values.vision === undefined && cliOverrides.vision === undefined) cliOverrides.vision = true;
    if (!values['screenshot-interval'] && cliOverrides.screenshotInterval === undefined) cliOverrides.screenshotInterval = 3;
    if (values['goal-verification'] === undefined) cliOverrides.goalVerification = true;
  }

  // Gen 13: vision/hybrid observation mode requires vision + screenshots.
  // Viewport forced to 1024×768 to match Claude's computer-use training
  // distribution — coordinates map 1:1 with no scaling needed.
  if (cliOverrides.observationMode === 'vision' || cliOverrides.observationMode === 'hybrid') {
    if (cliOverrides.vision === undefined) cliOverrides.vision = true;
    if (cliOverrides.visionStrategy === undefined) cliOverrides.visionStrategy = 'always';
    if (cliOverrides.screenshotInterval === undefined || cliOverrides.screenshotInterval === 0) {
      cliOverrides.screenshotInterval = 1;
    }
    if (!cliOverrides.viewport) {
      cliOverrides.viewport = { width: 1024, height: 768 };
    }
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
  // Gen 27: use patchright (Playwright fork with CDP leak fixes) for ALL
  // profiles. 13/50 WebbBench sites block standard Playwright via CDP
  // protocol detection (Runtime.enable leak). Fallback to regular
  // playwright if patchright isn't installed.
  const isStealthProfile = launchPlan.profile.includes('stealth');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browserLib: any;
  try {
    browserLib = await import('patchright');
  } catch {
    browserLib = await import('playwright');
  }
  const { chromium, firefox, webkit } = browserLib;
  const { PlaywrightDriver } = await import('./drivers/playwright.js');
  const { TestRunner } = await import('./test-runner.js');
  const { FilesystemSink } = await import('./artifacts/filesystem-sink.js');
  const { loadExtensions } = await import('./extensions/loader.js');
  const { TurnEventBus } = await import('./runner/events.js');

  // Optional live event bus + SSE viewer. Constructed only when `--live` is
  // passed; otherwise the runner uses an internal no-op bus and pays nothing.
  // The bus is shared across the entire suite so a single SSE connection
  // observes all turns of all test cases. Gen 32: when `--stream <url>` is
  // passed the bus is always created (even without --live) so the webhook
  // streamer has something to subscribe to.
  const liveEnabled = values.live === true;
  const streamUrl = typeof values.stream === 'string' && values.stream.length > 0 ? values.stream : undefined;
  const needsBus = liveEnabled || !!streamUrl;
  const liveBus = needsBus ? new TurnEventBus() : undefined;
  const liveCancelController = liveEnabled ? new AbortController() : undefined;
  let liveViewHandle: { url: string; close: () => Promise<void> } | undefined;
  if (liveEnabled && liveBus) {
    const { runLiveView } = await import('./cli-view-live.js');
    liveViewHandle = await runLiveView({
      bus: liveBus,
      ...(liveCancelController ? { cancelController: liveCancelController } : {}),
      port: values.port ? parseInt(values.port as string, 10) : undefined,
      noOpen: values['no-open'] === true,
    });
  }

  // Gen 32 — webhook streamer. When `--stream <url>` is passed, subscribe
  // to the bus and POST every event to <url> as it fires. Auth via
  // `--stream-token` or $BAD_STREAM_TOKEN. Non-fatal on failure — the
  // canonical record is always events.jsonl on disk.
  let webhookStreamer: import('./runner/stream-webhook.js').WebhookStreamer | undefined;
  if (streamUrl && liveBus) {
    const { WebhookStreamer } = await import('./runner/stream-webhook.js');
    const token = (values['stream-token'] as string | undefined) || process.env.BAD_STREAM_TOKEN;
    const streamId = `stream_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    webhookStreamer = new WebhookStreamer({
      url: streamUrl,
      authToken: token,
      streamId,
      onError: (err, dropped) => {
        if (!values.json) cliWarn(`stream: ${err.message} (dropped ${dropped} event${dropped === 1 ? '' : 's'})`);
      },
    }).attach(liveBus);
    if (!values.json) cliLog('stream', `POST → ${streamUrl} (id ${streamId})`);
  }

  // Gen 32 — interrupt controller. `--interrupt` enables keyboard pause/
  // resume/abort during a run. No-op in non-TTY (CI, piped output).
  let interruptController: import('./runner/interrupt-controller.js').InterruptController | undefined;
  let detachInterrupt: (() => void) | undefined;
  if (values.interrupt === true && process.stdin.isTTY) {
    const { InterruptController } = await import('./runner/interrupt-controller.js');
    interruptController = new InterruptController({
      onStatus: (msg) => { if (!values.json) cliLog('interrupt', msg); },
    });
    detachInterrupt = interruptController.attach();
  }

  // Auto-discover bad.config.{ts,mjs,js,...} from cwd plus any explicit
  // --extension paths. Failures are reported but never fatal: a broken user
  // config should warn, not abort the run.
  const explicitExtPaths = ((values.extension as string | string[] | undefined) ?? [])
  const explicitExtArr = Array.isArray(explicitExtPaths)
    ? explicitExtPaths
    : explicitExtPaths
      ? [explicitExtPaths]
      : []
  // Domain skills: markdown-based per-host rule libraries under
  // skills/domain/<host>/SKILL.md. They plumb into the same BadExtension
  // pipeline as user `bad.config.mjs` files via addRulesForDomain, so the
  // existing setExtensionRules injection at brain/index.ts:899 picks them up
  // with no second injection site. Gated by BAD_DOMAIN_SKILLS_DISABLED=1.
  const domainSkillsDisabled = process.env.BAD_DOMAIN_SKILLS_DISABLED === '1'
  let domainSkillExtension: import('./extensions/types.js').BadExtension | undefined
  let domainSkillsLoadedCount = 0
  if (!domainSkillsDisabled) {
    const { loadDomainSkills, buildDomainSkillExtension } = await import('./skills/domain-loader.js')
    const domainLoad = await loadDomainSkills()
    if (domainLoad.skills.length > 0) {
      domainSkillExtension = buildDomainSkillExtension(domainLoad.skills)
      domainSkillsLoadedCount = domainLoad.skills.length
    }
    if (domainLoad.errors.length > 0 && !values.json) {
      for (const err of domainLoad.errors) {
        cliWarn(`domain-skill load failed: ${err.path} — ${err.error}`)
      }
    }
  }

  const extensionLoad = await loadExtensions({ explicitPaths: explicitExtArr });
  if (extensionLoad.loadedFrom.length > 0 && !values.json) {
    cliLog('extensions', `loaded ${extensionLoad.loadedFrom.length}: ${extensionLoad.loadedFrom.join(', ')}`);
  }
  if (extensionLoad.errors.length > 0 && !values.json) {
    for (const err of extensionLoad.errors) {
      cliWarn(`extension load failed: ${err.path} — ${err.error}`);
    }
  }
  if (domainSkillExtension && domainSkillsLoadedCount > 0) {
    // Re-resolve the bundle with the domain-skill synthetic extension
    // merged in. Resolving twice is cheap (the list is short) and keeps
    // domainSkillExtension from having to plumb through a separate wire.
    const { resolveExtensions } = await import('./extensions/types.js')
    const combined = resolveExtensions([...extensionLoad.resolved.extensions, domainSkillExtension])
    extensionLoad.resolved = combined
    if (!values.json) cliLog('skills', `domain: ${domainSkillsLoadedCount} loaded`)
  }

  // Gen 29: macros. Loaded alongside domain skills; gated by
  // BAD_MACROS_DISABLED=1. The registry is passed to PlaywrightDriver
  // (dispatch) and its promptBlock to the BrowserAgent (visibility).
  const macrosDisabled = process.env.BAD_MACROS_DISABLED === '1'
  let macroRegistry: import('./skills/macro-loader.js').MacroRegistry | undefined
  if (!macrosDisabled) {
    const { loadMacros, buildMacroRegistry } = await import('./skills/macro-loader.js')
    const macroLoad = await loadMacros()
    if (macroLoad.errors.length > 0 && !values.json) {
      for (const err of macroLoad.errors) {
        cliWarn(`macro load failed: ${err.path} — ${err.error}`)
      }
    }
    if (macroLoad.macros.length > 0) {
      macroRegistry = buildMacroRegistry(macroLoad.macros)
      if (!values.json) cliLog('skills', `macros: ${macroLoad.macros.length} loaded`)
    }
  }

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
  } else if (values['cases-json'] || values.cases) {
    const raw = values['cases-json'] || fs.readFileSync(path.resolve(values.cases!), 'utf-8');
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
      ...(launchPlan.proxyServer ? { proxy: { server: launchPlan.proxyServer } } : {}),
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
      // System Chrome for stealth profiles only — real TLS/JA3 fingerprint
      // fixes anti-bot blocking. But system Chrome renders differently than
      // bundled Chromium on some sites (Allrecipes click timeouts, Amazon
      // layout shifts), so only enable when anti-bot evasion is needed.
      ...(isStealthProfile && browserName === 'chromium' ? { channel: 'chrome' } : {}),
      // Residential/SOCKS5/HTTP proxy — routes all traffic through the proxy
      ...(launchPlan.proxyServer ? { proxy: { server: launchPlan.proxyServer } } : {}),
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
        // navigator.connection — missing in headless, present in real Chrome
        try {
          if (!navigator.connection) {
            Object.defineProperty(navigator, 'connection', {
              get: () => ({
                effectiveType: '4g',
                rtt: 50,
                downlink: 10,
                saveData: false,
                onchange: null,
              }),
            });
          }
        } catch (_) {}
        // Notification.permission — default differs in headless
        try {
          if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
            Object.defineProperty(Notification, 'permission', { get: () => 'denied' });
          }
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
      showCursor: values['show-cursor'],
      ...(macroRegistry ? { macros: macroRegistry } : {}),
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
    extensions: extensionLoad.resolved,
    ...(macroRegistry ? { macroPromptBlock: macroRegistry.promptBlock } : {}),
    ...(liveBus ? { eventBus: liveBus } : {}),
    ...(interruptController
      ? { beforeTurn: async () => { await interruptController.waitIfPaused(); } }
      : {}),
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
    // Gen 32 — wire interrupt controller. When the user presses `q`,
    // abort() fires which the runner observes via the suite-level
    // signal. Runs a check before the runner starts so pressing `q`
    // BEFORE the first turn still aborts cleanly.
    const interruptSignal = interruptController
      ? (() => {
        const ac = new AbortController();
        interruptController.on('abort', () => ac.abort('interrupted by user'));
        if (interruptController.isAborted) ac.abort('interrupted by user');
        return ac.signal;
      })()
      : undefined;
    // If --live already provided a signal, merge both. Prefer the user
    // interrupt signal so `q` wins even when --live is set.
    const mergedSignal = interruptSignal ?? liveCancelController?.signal;
    result = await runner.runSuite(
      cases,
      mergedSignal ? { signal: mergedSignal } : undefined,
    );

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
    // Gen 32 — detach interrupt controller first so stdin leaves raw mode
    // BEFORE we try to write any shutdown logs. Otherwise the user's TTY
    // stays in raw mode after the run ends and Ctrl-C, arrow keys, etc.
    // come through as garbage bytes.
    if (detachInterrupt) detachInterrupt();
    // Flush and close the stream webhook so the final events (run-completed,
    // suite-complete) reach the endpoint before the CLI exits.
    if (webhookStreamer) await webhookStreamer.close().catch(() => {});
    await singleDriver?.close?.().catch(() => {});
    stopWalletAutoApprover?.();
    await persistentContext?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }

  if (runError) {
    if (liveViewHandle) {
      await liveViewHandle.close().catch(() => {});
    }
    throw runError;
  }

  const runLabel = values.cases
    ? `${path.basename(values.cases)} · cli run`
    : `${(values.goal || values['resume-run'] || values['fork-run'] || 'run').slice(0, 80)} · cli run`
  await syncLocalBenchmarkRun(path.resolve(sinkDir), runLabel);

  // In --live mode, the user usually wants to scrub the final state in the
  // viewer after the run finishes. Hold the process open until SIGINT and
  // shut down the live server cleanly when the user hits Ctrl+C.
  if (liveViewHandle) {
    cliLog('live', `run complete — viewer at ${liveViewHandle.url} (Ctrl+C to exit)`);
    await new Promise<void>((resolve) => {
      const onSigint = () => {
        liveViewHandle!.close().finally(() => resolve());
      };
      process.once('SIGINT', onSigint);
    });
  }

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

// Flush telemetry on every exit path (`process.exit` from inside main, throw, or
// natural completion). beforeExit fires before Node decides to terminate, so
// any pending HTTP POSTs from HttpTelemetrySink finish flushing before we go.
process.on('beforeExit', () => {
  void getTelemetry().close();
});

main().catch((err) => {
  cliError(err instanceof Error ? err.message : String(err));
  void getTelemetry().close().finally(() => process.exit(1));
});
