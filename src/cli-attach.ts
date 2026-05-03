/**
 * Attach mode — connect to the user's already-running Chrome via CDP.
 *
 * The agent drives the user's real browser instead of launching a fresh
 * Chromium, which preserves
 * login state, cookies, SSO — the workflows that "automate anything
 * I'm already logged into" need.
 *
 * Two entrypoints:
 *   - `bad --attach` probes 127.0.0.1:9222 (or `--attach-port`),
 *     populates the existing cdpUrl path at cli.ts:916.
 *   - `bad chrome-debug` launches the user's system Chrome with
 *     `--remote-debugging-port=<port>` pointed at their default profile
 *     so attach has something to connect to.
 *
 * Attach is fundamentally incompatible with wallet mode and extension
 * loading — both require launchPersistentContext. Those combinations
 * error out with a clear message rather than silently ignoring flags.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import chalk from 'chalk'
import { cliError, cliLog } from './cli-ui.js'

export const DEFAULT_ATTACH_PORT = 9222

export interface ChromeDebugInfo {
  /** WebSocket URL for CDP (passable to playwright.chromium.connectOverCDP) */
  webSocketDebuggerUrl: string
  /** Human-readable browser label (e.g. "Chrome/131.0.6778.86") */
  browser?: string
  /** Raw probe payload for diagnostics */
  raw: unknown
}

export interface ProbeOptions {
  host?: string
  port?: number
  /** Abort probe after this many ms. Default 1500. */
  timeoutMs?: number
  /** Injected fetch for tests */
  fetchImpl?: typeof fetch
}

/**
 * Probe the Chrome DevTools JSON endpoint at host:port/json/version.
 * Returns connection info if Chrome is listening, null if the probe
 * fails (no listener, non-JSON body, missing field, timeout).
 *
 * Never throws — attach UX hinges on a probe that reports "not running"
 * rather than crashing when the user hasn't started Chrome yet.
 */
export async function probeChromeDebug(opts: ProbeOptions = {}): Promise<ChromeDebugInfo | null> {
  const host = opts.host ?? '127.0.0.1'
  const port = opts.port ?? DEFAULT_ATTACH_PORT
  const timeoutMs = opts.timeoutMs ?? 1500
  const fetchImpl = opts.fetchImpl ?? fetch
  const url = `http://${host}:${port}/json/version`
  // Single AbortController spans the whole request: connect + headers +
  // body read. Per the fetch spec, aborting mid-stream propagates into
  // body.text()/json(), so a server that sends headers then stalls the
  // body gets cut off at the same timeout as a dead-port connection.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { signal: controller.signal })
    if (!res.ok) return null
    const body = await res.json() as Record<string, unknown>
    const ws = body?.webSocketDebuggerUrl
    if (typeof ws !== 'string' || ws.length === 0) return null
    const browserLabel = typeof body?.Browser === 'string' ? body.Browser : undefined
    return { webSocketDebuggerUrl: ws, browser: browserLabel, raw: body }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export interface ResolveAttachOptions {
  /** Host (default 127.0.0.1) */
  host?: string
  /** Port (default 9222). */
  port?: number
  /** Max probe attempts; ms between attempts comes from `retryDelayMs`. */
  attempts?: number
  retryDelayMs?: number
  /** Injected for tests */
  probeImpl?: (o: ProbeOptions) => Promise<ChromeDebugInfo | null>
  /** Injected for tests */
  sleepImpl?: (ms: number) => Promise<void>
}

/**
 * Probe up to `attempts` times with `retryDelayMs` between tries.
 * Returns the resolved info or throws a user-facing error explaining
 * how to start Chrome with debugging enabled.
 */
export async function resolveAttachEndpoint(opts: ResolveAttachOptions = {}): Promise<ChromeDebugInfo> {
  const host = opts.host ?? '127.0.0.1'
  const port = opts.port ?? DEFAULT_ATTACH_PORT
  const attempts = Math.max(1, opts.attempts ?? 1)
  const delay = Math.max(0, opts.retryDelayMs ?? 500)
  const probe = opts.probeImpl ?? probeChromeDebug
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise(res => setTimeout(res, ms)))

  for (let i = 0; i < attempts; i++) {
    const info = await probe({ host, port })
    if (info) return info
    if (i < attempts - 1) await sleep(delay)
  }
  throw new Error(
    `No Chrome DevTools listener on ${host}:${port}. ` +
    `Start your Chrome with remote debugging first:\n` +
    `    bad chrome-debug\n` +
    `…or pass --cdp-url <ws://...> to target a different endpoint.`,
  )
}

/** Find the user's system Chrome binary. Returns null if none found. */
export function findChromeBinary(platform: NodeJS.Platform = process.platform): string | null {
  const candidates: string[] = []
  if (platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    )
  } else if (platform === 'linux') {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    )
  } else if (platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    )
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Return the user's default Chrome profile directory for this platform,
 * or null if we can't locate it. Used by `chrome-debug` to launch against
 * the real profile (so login state is preserved).
 */
export function findChromeUserDataDir(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
): string | null {
  let candidate: string | null = null
  if (platform === 'darwin') {
    candidate = path.join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome')
  } else if (platform === 'linux') {
    candidate = path.join(homeDir, '.config', 'google-chrome')
  } else if (platform === 'win32') {
    candidate = path.join(homeDir, 'AppData', 'Local', 'Google', 'Chrome', 'User Data')
  }
  if (candidate && fs.existsSync(candidate)) return candidate
  return null
}

export interface ChromeDebugOptions {
  port?: number
  /** Override the user-data-dir. Default: the system profile. */
  userDataDir?: string
  /** Override Chrome binary path. Default: auto-detected. */
  binary?: string
  /** Injected for tests */
  spawnImpl?: typeof spawn
  /** Injected for tests */
  probeImpl?: (o: ProbeOptions) => Promise<ChromeDebugInfo | null>
  /** Injected for tests */
  platform?: NodeJS.Platform
  /** Injected for tests */
  homeDir?: string
  /** Total wait time for the port to open before giving up. Default 10s. */
  readyTimeoutMs?: number
}

/**
 * Launch the user's system Chrome with `--remote-debugging-port=<port>`
 * against their default profile. Waits up to readyTimeoutMs for the
 * port to respond, then returns the probe info.
 *
 * This is intentionally ergonomic over "correct for all edge cases" —
 * advanced users with non-default Chrome installs or custom profiles
 * should still use `--cdp-url` directly. This handles the 90% case.
 */
export async function handleChromeDebug(opts: ChromeDebugOptions = {}): Promise<ChromeDebugInfo> {
  const platform = opts.platform ?? process.platform
  const homeDir = opts.homeDir ?? os.homedir()
  const port = opts.port ?? DEFAULT_ATTACH_PORT
  const probe = opts.probeImpl ?? probeChromeDebug
  const spawnFn = opts.spawnImpl ?? spawn

  // If Chrome is already listening on the port, just return it.
  const existing = await probe({ port })
  if (existing) {
    cliLog('attach', `Chrome already listening on :${port} (${existing.browser ?? 'unknown'})`)
    return existing
  }

  const binary = opts.binary ?? findChromeBinary(platform)
  if (!binary) {
    throw new Error(
      `Could not locate a system Chrome binary on ${platform}. ` +
      `Install Chrome, or start it manually with --remote-debugging-port=${port} and pass --cdp-url.`,
    )
  }
  const userDataDir = opts.userDataDir ?? findChromeUserDataDir(platform, homeDir) ?? undefined

  const args = [
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
  ]
  if (userDataDir) args.push(`--user-data-dir=${userDataDir}`)

  cliLog('attach', `launching ${binary}`)
  if (userDataDir) cliLog('attach', `using profile ${userDataDir}`)

  const child = spawnFn(binary, args, {
    detached: true,
    stdio: 'ignore',
  })
  // Capture early exit so the thrown error at deadline can name the exit
  // code instead of generically saying "timed out". `detached:true` means
  // we deliberately don't block on the child, but we still want to know if
  // it died before our probe succeeded.
  let childExitCode: number | null = null
  let childExitSignal: NodeJS.Signals | null = null
  child.on?.('exit', (code, signal) => {
    childExitCode = code
    childExitSignal = signal
  })
  child.unref?.()

  const deadline = Date.now() + (opts.readyTimeoutMs ?? 10_000)
  while (Date.now() < deadline) {
    if (childExitCode !== null || childExitSignal !== null) {
      throw new Error(
        `Chrome exited before the DevTools endpoint came up ` +
        `(code=${childExitCode ?? 'null'} signal=${childExitSignal ?? 'null'}). ` +
        `Another Chrome instance may be holding the profile lock — quit it and retry.`,
      )
    }
    const info = await probe({ port })
    if (info) {
      cliLog('attach', `connected (${info.browser ?? 'chrome'})`)
      return info
    }
    await new Promise(res => setTimeout(res, 250))
  }
  // Deadline hit without a successful probe. Kill the child we spawned so
  // the user doesn't accumulate zombie Chrome processes on repeated tries.
  if (child.pid && !child.killed) {
    try { child.kill('SIGTERM') } catch { /* best-effort */ }
  }
  throw new Error(
    `Chrome launched but the DevTools endpoint didn't come up within ${opts.readyTimeoutMs ?? 10_000}ms. ` +
    `Try starting Chrome manually:\n    "${binary}" --remote-debugging-port=${port}`,
  )
}

/**
 * CLI subcommand entrypoint. Wraps handleChromeDebug with help-text
 * output. Exits with the probe info printed so the user (or a shell
 * script) can copy the WS URL.
 */
export async function runChromeDebugCommand(opts: {
  port?: number
  userDataDir?: string
  quiet?: boolean
}): Promise<number> {
  try {
    const info = await handleChromeDebug({
      port: opts.port,
      userDataDir: opts.userDataDir,
    })
    if (!opts.quiet) {
      console.log('')
      console.log(`  ${chalk.green('✓')} Chrome debugging: ${info.webSocketDebuggerUrl}`)
      console.log(`  ${chalk.dim('run:')} bad --attach ${opts.port && opts.port !== DEFAULT_ATTACH_PORT ? `--attach-port ${opts.port} ` : ''}--goal "..."`)
      console.log('')
    }
    return 0
  } catch (err) {
    cliError(err instanceof Error ? err.message : String(err))
    return 1
  }
}

/**
 * Assert-helper used by the main run path. Hard-errors when a caller
 * passed flags that attach mode cannot honor — no silent fallback, no
 * "warn and do the wrong thing." If the user said --profile-dir AND
 * --attach, they meant something, and we shouldn't guess.
 */
export function validateAttachConflicts(opts: {
  walletEnabled: boolean
  profileDir?: string
  extensionPaths?: string[]
  userDataDir?: string
}): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = []
  if (opts.walletEnabled) {
    errors.push(
      'Attach mode connects to your real Chrome and cannot load the wallet extension. ' +
      'Use `bad --wallet` (without --attach) for wallet flows.',
    )
  }
  if (opts.extensionPaths && opts.extensionPaths.length > 0) {
    errors.push(
      'Attach mode cannot load extensions (they must be installed in the running Chrome already). ' +
      'Drop --extension, or use `bad --wallet` for wallet extensions.',
    )
  }
  if (opts.profileDir) {
    errors.push(
      '--profile-dir is incompatible with --attach. ' +
      'The attached Chrome uses its own profile — drop --profile-dir or run without --attach.',
    )
  }
  if (opts.userDataDir) {
    errors.push(
      '--user-data-dir is incompatible with --attach. ' +
      'The attached Chrome uses its own data dir — drop --user-data-dir or run without --attach.',
    )
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true }
}
