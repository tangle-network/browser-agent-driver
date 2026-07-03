import * as path from 'node:path';
import type { DriverConfig } from './config.js';

export interface BrowserLaunchPlan {
  profile: NonNullable<DriverConfig['profile']>;
  /** Connect to an existing browser via CDP instead of launching */
  cdpUrl?: string;
  persistentContext: boolean;
  walletMode: boolean;
  headless: boolean;
  concurrency: number;
  viewport: { width: number; height: number };
  browserArgs: string[];
  extensionPaths: string[];
  userDataDir?: string;
  /** Residential/SOCKS5/HTTP proxy URL (e.g. http://user:pass@proxy:port) */
  proxyServer?: string;
  /** Comma-separated host bypass list for the proxy (from NO_PROXY, managed-egress only). */
  proxyBypass?: string;
  /**
   * Relax Chromium TLS validation for the run. Set ONLY when we auto-detect the sandbox's managed
   * egress proxy (iron-proxy MITM), whose CA is trusted by CLI tools via NODE_EXTRA_CA_CERTS but is
   * not installed in Chromium's trust store. Playwright has no "trust one CA" option, so this accepts
   * ALL cert errors for the run — acceptable only because it is gated on the EGRESS_PROXY_IP sentinel,
   * never set for a user-supplied --proxy/BAD_PROXY_URL, and all egress already goes through the proxy.
   * Optional so external consumers constructing a plan literal aren't type-broken by this field.
   */
  ignoreHTTPSErrors?: boolean;
  /**
   * Absolute path to a Chromium binary to launch instead of the Playwright-managed
   * browser (Chromium only). When set, launch sites pass it as `executablePath` and
   * omit `channel` — Playwright treats the two as mutually exclusive.
   */
  executablePath?: string;
  warnings: string[];
  errors: string[];
}

export interface BuildBrowserLaunchPlanOptions {
  cwd?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

function resolveMaybeRelativePath(value: string, cwd: string): string {
  if (!value) return value;
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

/**
 * Build an execution plan for browser launch behavior.
 * Wallet mode is enabled when wallet.enabled or wallet.extensionPaths are set.
 */
export function buildBrowserLaunchPlan(
  config: DriverConfig,
  options: BuildBrowserLaunchPlanOptions = {},
): BrowserLaunchPlan {
  const cwd = options.cwd ?? process.cwd();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const warnings: string[] = [];
  const errors: string[] = [];
  const profile = config.profile ?? 'default';

  const viewport = config.viewport ?? { width: 1920, height: 1080 };
  const requestedConcurrency = config.concurrency ?? 1;
  const requestedHeadless = config.headless ?? true;
  const walletConfig = config.wallet;

  const extensionPaths = (walletConfig?.extensionPaths ?? [])
    .filter((p): p is string => Boolean(p))
    .map((p) => resolveMaybeRelativePath(p, cwd));

  const userDataDir = walletConfig?.userDataDir
    ? resolveMaybeRelativePath(walletConfig.userDataDir, cwd)
    : undefined;

  const profileDir = config.profileDir
    ? resolveMaybeRelativePath(config.profileDir, cwd)
    : undefined

  const cdpUrl = config.cdpUrl || undefined
  const walletMode = Boolean(walletConfig?.enabled) || extensionPaths.length > 0;
  const persistentContext = walletMode || Boolean(profileDir)

  if (!walletMode && !profileDir && userDataDir) {
    warnings.push('wallet.userDataDir is set but wallet mode is disabled; this directory is ignored unless --wallet or --extension is provided.');
  }

  let headless = requestedHeadless;
  if (walletMode && headless) {
    warnings.push(
      'Wallet mode is running headless. Extension compatibility depends on your Chromium build; use headed mode if wallet prompts fail.',
    );
  }

  let concurrency = requestedConcurrency;
  if (walletMode && concurrency !== 1) {
    concurrency = 1;
    warnings.push(`Wallet mode is single-session. Overriding concurrency=${requestedConcurrency} to concurrency=1.`);
  }

  if (walletMode && platform === 'linux' && !headless) {
    const display = env.DISPLAY?.trim() ?? '';
    const waylandDisplay = env.WAYLAND_DISPLAY?.trim() ?? '';
    const hasDisplay = display.length > 0;
    const hasWaylandDisplay = waylandDisplay.length > 0;

    if (!hasDisplay && !hasWaylandDisplay) {
      errors.push(
        'Wallet mode on Linux requires a display server, but neither DISPLAY nor WAYLAND_DISPLAY is set. Start an X11/Wayland session or use xvfb-run, then retry.',
      );
    }

    if (hasDisplay && !(env.XAUTHORITY?.trim())) {
      warnings.push(
        'DISPLAY is set but XAUTHORITY is not. If Chromium cannot connect to X11, export XAUTHORITY to your active session auth file.',
      );
    }

    if (hasWaylandDisplay && !(env.XDG_RUNTIME_DIR?.trim())) {
      warnings.push(
        'WAYLAND_DISPLAY is set but XDG_RUNTIME_DIR is not. If Chromium cannot connect to Wayland, set XDG_RUNTIME_DIR for your session.',
      );
    }
  }

  const browserArgs = [...(config.browserArgs ?? [])];
  applyProfileBrowserArgs(profile, browserArgs);
  if (walletMode && extensionPaths.length > 0) {
    const extensionsCsv = extensionPaths.join(',');
    browserArgs.push(`--disable-extensions-except=${extensionsCsv}`);
    browserArgs.push(`--load-extension=${extensionsCsv}`);
  }

  if (cdpUrl && persistentContext) {
    warnings.push('--cdp-url connects to an existing browser; --profile-dir and wallet options are ignored.')
  }

  // Explicit Chromium binary (e.g. the sandbox's Nix Chromium) — config wins over env.
  const executablePath = config.executablePath || env.BAD_CHROMIUM_EXECUTABLE_PATH || undefined;

  // Explicit user proxy (residential/SOCKS5/custom) always wins and keeps cert validation on.
  const explicitProxy = config.proxy || env.BAD_PROXY_URL || undefined;
  // Otherwise, auto-wire the sandbox's managed egress proxy (iron-proxy) if present. Playwright's
  // Chromium ignores HTTP_PROXY/HTTPS_PROXY env, so without this the browser connects directly and
  // the host egress firewall drops it (ERR_NAME_NOT_RESOLVED → chrome-error).
  const managedEgressProxy = explicitProxy ? undefined : resolveManagedEgressProxy(env);
  const proxyServer = explicitProxy ?? managedEgressProxy?.server;
  const proxyBypass = managedEgressProxy?.bypass;
  // Accept the proxy's MITM cert (see BrowserLaunchPlan.ignoreHTTPSErrors) — egress proxy only.
  const ignoreHTTPSErrors = Boolean(managedEgressProxy);
  if (managedEgressProxy) {
    warnings.push(
      `Routing the browser through the managed egress proxy (${managedEgressProxy.server}) and accepting its TLS-interception certificate; outbound is otherwise blocked by the sandbox egress firewall.`,
    );
    if (cdpUrl) {
      // CDP attaches to a browser we didn't launch, so the proxy/cert wiring never reaches it.
      warnings.push(
        '--cdp-url connects to an existing browser; the managed egress proxy is NOT applied to it, so its pages may be blocked by the sandbox egress firewall.',
      );
    }
  } else if (!explicitProxy && env.EGRESS_PROXY_IP?.trim()) {
    // Sentinel present but no HTTPS_PROXY/HTTP_PROXY to route through — surface the misconfig instead
    // of silently letting the browser connect directly and hit ERR_NAME_NOT_RESOLVED (the bug this fixes).
    warnings.push(
      'EGRESS_PROXY_IP is set but neither HTTPS_PROXY nor HTTP_PROXY is; the browser will connect directly and may be blocked by the sandbox egress firewall.',
    );
  }

  return {
    profile,
    cdpUrl,
    persistentContext,
    walletMode,
    headless,
    concurrency,
    viewport,
    browserArgs,
    extensionPaths,
    userDataDir: userDataDir ?? (walletMode ? undefined : profileDir),
    proxyServer,
    proxyBypass,
    ignoreHTTPSErrors,
    executablePath,
    warnings,
    errors,
  };
}

/**
 * Detect the sandbox's managed egress proxy. Sandbox hosts running iron-proxy inject
 * `EGRESS_PROXY_IP` plus `HTTPS_PROXY`/`HTTP_PROXY` to force all outbound traffic through a
 * per-sandbox TLS-intercepting proxy. We gate on `EGRESS_PROXY_IP` (the managed-egress sentinel)
 * so we only auto-wire — and only relax cert validation for — the trusted in-sandbox proxy, never
 * an arbitrary ambient `HTTP_PROXY` a user happens to have exported.
 */
function resolveManagedEgressProxy(
  env: NodeJS.ProcessEnv,
): { server: string; bypass?: string } | undefined {
  if (!env.EGRESS_PROXY_IP?.trim()) return undefined;
  // Prefer the CONNECT listener (HTTPS_PROXY) — browser traffic is predominantly HTTPS.
  const server = (env.HTTPS_PROXY ?? env.HTTP_PROXY ?? '').trim();
  if (!server) return undefined;
  const bypass = env.NO_PROXY?.trim() || undefined;
  return { server, bypass };
}

function applyProfileBrowserArgs(
  profile: NonNullable<DriverConfig['profile']>,
  browserArgs: string[],
): void {
  // Apply stealth args to all profiles to reduce common automation fingerprints.
  const stealthArgs = [
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    '--no-first-run',
    '--no-default-browser-check',
    // Real GPU rendering — headless defaults to SwiftShader which has a
    // distinct WebGL fingerprint that anti-bot systems flag.
    '--use-gl=desktop',
  ];

  for (const arg of stealthArgs) {
    if (!browserArgs.includes(arg)) {
      browserArgs.push(arg);
    }
  }

  // benchmark-webbench uses additional non-stealth settings — keep as-is
  void profile;
}
