import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BrowserContext } from 'playwright';
import { toAgentConfig } from '../../config.js';
import { buildBrowserLaunchPlan } from '../../browser-launch.js';
import { isPlaywrightFfmpegAvailable } from '../../ffmpeg-availability.js';
import { runWalletPreflight, startWalletAutoApprover } from '../../wallet/automation.js';
import { isPersonaId, listPersonaIds, withPersonaDirective } from '../../personas.js';
import { resolveProviderApiKey, resolveProviderModelName, resolveDefaultProvider } from '../../provider-defaults.js';
import { CliRenderer, cliError, cliWarn, cliLog } from '../../cli-ui.js';
import { ProjectStore } from '../../memory/project-store.js';
import { RunRegistry } from '../../memory/run-registry.js';
import { applyStorageStateToPersistentContext } from '../../browser/storage-state.js';
import { STEALTH_INIT_SCRIPT } from '../../browser/stealth-init-script.js';
import { installWalletRpcInterception } from '../../wallet/rpc-interception.js';
import { buildDriverConfig } from '../build-config.js';
import { readCliVersion } from '../version.js';
import { syncLocalBenchmarkRun } from '../benchmark-sync.js';
import type { CliValues } from '../args.js';

export async function runRunCommand(values: CliValues): Promise<void> {
  // Validate inputs
  if (!values.goal && !values.cases && !values['cases-json'] && !values['resume-run'] && !values['fork-run']) {
    cliError('provide --goal "..." --url "..." for a single task, --cases ./cases.json (or --cases-json \'[...]\') for a suite, or --resume-run / --fork-run <runId>.');
    process.exit(1);
  }

  // Load config file, overlay CLI flags, apply presets.
  const driverConfig = await buildDriverConfig(values);
  const mode = values.mode;
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

  // Dynamic imports keep startup fast. Prefer patchright for lower browser
  // automation fingerprinting, falling back to regular Playwright.
  const isStealthProfile = launchPlan.profile.includes('stealth');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browserLib: any;
  try {
    browserLib = await import('patchright');
  } catch {
    browserLib = await import('playwright');
  }
  const { chromium, firefox, webkit } = browserLib;
  const { PlaywrightDriver } = await import('../../drivers/playwright.js');
  const { TestRunner } = await import('../../test-runner.js');
  const { FilesystemSink } = await import('../../artifacts/filesystem-sink.js');
  const { loadExtensions } = await import('../../extensions/loader.js');
  const { TurnEventBus } = await import('../../runner/events.js');

  // Optional live event bus + SSE viewer. Constructed only when `--live` is
  // passed; otherwise the runner uses an internal no-op bus and pays nothing.
  // The bus is shared across the entire suite so a single SSE connection
  // observes all turns of all test cases. When `--stream <url>` is passed
  // the bus is always created so the webhook streamer can subscribe.
  const liveEnabled = values.live === true;
  const streamUrl = typeof values.stream === 'string' && values.stream.length > 0 ? values.stream : undefined;
  const needsBus = liveEnabled || !!streamUrl;
  const liveBus = needsBus ? new TurnEventBus() : undefined;
  const liveCancelController = liveEnabled ? new AbortController() : undefined;
  let liveViewHandle: { url: string; close: () => Promise<void> } | undefined;
  if (liveEnabled && liveBus) {
    const { runLiveView } = await import('../../cli-view-live.js');
    liveViewHandle = await runLiveView({
      bus: liveBus,
      ...(liveCancelController ? { cancelController: liveCancelController } : {}),
      port: values.port ? parseInt(values.port as string, 10) : undefined,
      noOpen: values['no-open'] === true,
    });
  }

  // Webhook streamer. When `--stream <url>` is passed, subscribe
  // to the bus and POST every event to <url> as it fires. Auth via
  // `--stream-token` or $BAD_STREAM_TOKEN. Non-fatal on failure — the
  // canonical record is always events.jsonl on disk.
  let webhookStreamer: import('../../runner/stream-webhook.js').WebhookStreamer | undefined;
  if (streamUrl && liveBus) {
    const { WebhookStreamer } = await import('../../runner/stream-webhook.js');
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

  // Interrupt controller. `--interrupt` enables keyboard pause/
  // resume/abort during a run. No-op in non-TTY (CI, piped output).
  let interruptController: import('../../runner/interrupt-controller.js').InterruptController | undefined;
  let detachInterrupt: (() => void) | undefined;
  if (values.interrupt === true && process.stdin.isTTY) {
    const { InterruptController } = await import('../../runner/interrupt-controller.js');
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
  let domainSkillExtension: import('../../extensions/types.js').BadExtension | undefined
  let domainSkillsLoadedCount = 0
  if (!domainSkillsDisabled) {
    const { loadDomainSkills, buildDomainSkillExtension } = await import('../../skills/domain-loader.js')
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
    const { resolveExtensions } = await import('../../extensions/types.js')
    const combined = resolveExtensions([...extensionLoad.resolved.extensions, domainSkillExtension])
    extensionLoad.resolved = combined
    if (!values.json) cliLog('skills', `domain: ${domainSkillsLoadedCount} loaded`)
  }

  // Macros. Loaded alongside domain skills; gated by BAD_MACROS_DISABLED=1.
  // The registry is passed to PlaywrightDriver and its promptBlock to BrowserAgent.
  const macrosDisabled = process.env.BAD_MACROS_DISABLED === '1'
  let macroRegistry: import('../../skills/macro-loader.js').MacroRegistry | undefined
  if (!macrosDisabled) {
    const { loadMacros, buildMacroRegistry } = await import('../../skills/macro-loader.js')
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

  const resolvedProvider = driverConfig.provider || resolveDefaultProvider();
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
  let cases: import('../../types.js').TestCase[];

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
    const version = readCliVersion();
    renderer.banner({
      version,
      provider: config.provider || resolveDefaultProvider(),
      model: config.model,
      browser: browserName,
      testCount: cases.length,
      concurrency,
      mode: mode || undefined,
      profile: driverConfig.profile,
      adaptiveRouting: config.adaptiveModelRouting ? {
        navProvider: config.navProvider || config.provider || resolveDefaultProvider(),
        navModel: config.navModel || 'gpt-4.1-mini',
      } : undefined,
      outputDir: sinkDir,
    });
  }

  // Set up artifact sink
  const sink = new FilesystemSink(path.resolve(sinkDir));
  const videoDir = path.join(sinkDir, '_videos');
  const viewport = launchPlan.viewport;

  // Video recording needs Playwright/patchright's bundled ffmpeg. The Tangle
  // sandbox's agent-thin runtime seeds the warm browser cache with Chromium but
  // NOT ffmpeg, so a context opened with `recordVideo` throws at page creation
  // ("Executable doesn't exist at .../ffmpeg-<rev>/ffmpeg-linux") and kills the
  // whole run. When ffmpeg is absent we drop `recordVideo` and keep going —
  // report, screenshots, and trace are still captured; only the replay video is
  // skipped. In normal dev/CI (ffmpeg present) recording is unchanged.
  const recordVideo = isPlaywrightFfmpegAvailable();
  if (!recordVideo) {
    cliWarn(
      'ffmpeg not found in the Playwright browser cache; recording video disabled for this run ' +
        '(report, screenshots, and trace are still captured).',
    );
  }
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
      // An explicit Chromium binary (e.g. the sandbox's Nix Chromium via
      // BAD_CHROMIUM_EXECUTABLE_PATH) overrides the Playwright-managed channel;
      // Playwright ignores `channel` when `executablePath` is set.
      ...(launchPlan.executablePath
        ? { executablePath: launchPlan.executablePath }
        : { channel: isStealthProfile ? 'chrome' : 'chromium' }),
      headless: launchPlan.headless,
      args: launchPlan.browserArgs,
      viewport,
      ...(recordVideo ? { recordVideo: { dir: videoDir, size: viewport } } : {}),
      ...(launchPlan.proxyServer
        ? { proxy: { server: launchPlan.proxyServer, ...(launchPlan.proxyBypass ? { bypass: launchPlan.proxyBypass } : {}) } }
        : {}),
      ...(launchPlan.ignoreHTTPSErrors ? { ignoreHTTPSErrors: true } : {}),
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
        await installWalletRpcInterception(persistentContext, {
          rpcUrl: walletRpcUrl,
          walletAddress: walletConfig.address,
        });
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
      // An explicit Chromium binary (the sandbox's Nix Chromium via
      // BAD_CHROMIUM_EXECUTABLE_PATH) takes precedence over the stealth
      // system-Chrome channel; Playwright ignores `channel` alongside
      // `executablePath`. Otherwise use system Chrome for stealth profiles only —
      // real TLS/JA3 fingerprint fixes anti-bot blocking, but system Chrome
      // renders differently than bundled Chromium on some sites (Allrecipes click
      // timeouts, Amazon layout shifts), so only enable when evasion is needed.
      ...(browserName === 'chromium' && launchPlan.executablePath
        ? { executablePath: launchPlan.executablePath }
        : isStealthProfile && browserName === 'chromium'
          ? { channel: 'chrome' }
          : {}),
      // Residential/SOCKS5/HTTP proxy — routes all traffic through the proxy
      ...(launchPlan.proxyServer
        ? { proxy: { server: launchPlan.proxyServer, ...(launchPlan.proxyBypass ? { bypass: launchPlan.proxyBypass } : {}) } }
        : {}),
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
      // A freshly-created CDP context still honors egress; the reused contexts[0] is the user's own
      // browser context (see the --cdp-url egress warning in buildBrowserLaunchPlan), left untouched.
      context = contexts[0] ?? await browser!.newContext({
        viewport,
        ...(launchPlan.ignoreHTTPSErrors ? { ignoreHTTPSErrors: true } : {}),
      })
    } else if (persistentContext) {
      context = persistentContext
    } else {
      context = await browser!.newContext({
        viewport,
        ...(recordVideo ? { recordVideo: { dir: videoDir, size: viewport } } : {}),
        storageState: storageStatePath,
        locale: 'en-US',
        timezoneId: 'America/New_York',
        ...(headlessUserAgent ? { userAgent: headlessUserAgent } : {}),
        // Accept the managed egress proxy's MITM cert (its CA isn't in Chromium's trust store).
        ...(launchPlan.ignoreHTTPSErrors ? { ignoreHTTPSErrors: true } : {}),
        extraHTTPHeaders: {
          'Accept-Language': 'en-US,en;q=0.9',
        },
      })
    }

    // Stealth patches: only for Playwright-controlled contexts (not real user browsers)
    if (!cdpConnected) {
      await context.addInitScript(STEALTH_INIT_SCRIPT);
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
    const wrappedDriver: import('../../drivers/types.js').Driver = {
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
  let singleDriver: import('../../drivers/types.js').Driver | undefined;
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

  let result: import('../../types.js').TestSuiteResult | undefined;
  let runError: unknown;

  try {
    // Wire interrupt controller. Pressing `q` aborts via the suite-level signal.
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
    const { generateReport } = await import('../../test-report.js');
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
    // Detach interrupt controller first so stdin leaves raw mode before
    // shutdown logs are written.
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
