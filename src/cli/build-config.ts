import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig, mergeConfig } from '../config.js';
import type { DriverConfig } from '../config.js';
import { cliError, cliLog } from '../cli-ui.js';
import { RUN_MODES, DRIVER_PROFILES } from './constants.js';
import type { RunMode, DriverProfile } from './constants.js';
import type { CliValues } from './args.js';

/**
 * Resolve the effective DriverConfig: load the config file, then overlay only
 * the CLI flags that were explicitly passed, apply profile/mode presets, and
 * merge. Validation failures (bad --mode/--profile, missing --prompt-file,
 * unresolvable --attach endpoint) call cliError and exit, matching the inline
 * behavior this replaced.
 */
export async function buildDriverConfig(values: CliValues): Promise<DriverConfig> {
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
    const { resolveAttachEndpoint, validateAttachConflicts } = await import('../cli-attach.js')
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

  // Vision and hybrid observation modes require screenshots and a stable
  // 1024×768 coordinate space.
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

  return mergeConfig(fileConfig, cliOverrides);
}
