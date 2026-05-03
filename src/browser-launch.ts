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

  const proxyServer = config.proxy || process.env.BAD_PROXY_URL || undefined;

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
    warnings,
    errors,
  };
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
