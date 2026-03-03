import * as path from 'node:path';
import type { DriverConfig } from './config.js';

export interface BrowserLaunchPlan {
  walletMode: boolean;
  headless: boolean;
  concurrency: number;
  viewport: { width: number; height: number };
  browserArgs: string[];
  extensionPaths: string[];
  userDataDir?: string;
  warnings: string[];
}

export interface BuildBrowserLaunchPlanOptions {
  cwd?: string;
}

function resolveMaybeRelativePath(value: string, cwd: string): string {
  if (!value) return value;
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

/**
 * Build an execution plan for browser launch behavior.
 * Wallet mode is enabled when wallet.enabled, wallet.extensionPaths, or wallet.userDataDir is set.
 */
export function buildBrowserLaunchPlan(
  config: DriverConfig,
  options: BuildBrowserLaunchPlanOptions = {},
): BrowserLaunchPlan {
  const cwd = options.cwd ?? process.cwd();
  const warnings: string[] = [];

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

  const walletMode = Boolean(walletConfig?.enabled) || extensionPaths.length > 0 || Boolean(userDataDir);

  let headless = requestedHeadless;
  if (walletMode && headless) {
    headless = false;
    warnings.push('Wallet mode requires headed Chromium. Forcing headless=false.');
  }

  let concurrency = requestedConcurrency;
  if (walletMode && concurrency > 1) {
    concurrency = 1;
    warnings.push('Wallet mode is single-session. Forcing concurrency=1.');
  }

  const browserArgs = [...(config.browserArgs ?? [])];
  if (walletMode && extensionPaths.length > 0) {
    const extensionsCsv = extensionPaths.join(',');
    browserArgs.push(`--disable-extensions-except=${extensionsCsv}`);
    browserArgs.push(`--load-extension=${extensionsCsv}`);
  }

  return {
    walletMode,
    headless,
    concurrency,
    viewport,
    browserArgs,
    extensionPaths,
    userDataDir,
    warnings,
  };
}
