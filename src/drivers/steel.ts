/**
 * SteelDriver — run bad's agent loop against a Steel-managed remote browser.
 *
 * Steel (https://steel.dev) provides cloud browser infrastructure with
 * CAPTCHA solving, residential proxies, fingerprint rotation, session
 * recording, and 24h sessions. This adapter lets you keep bad's agent
 * loop, design audit, evolve loops, wallet automation, etc., while
 * delegating the browser layer to Steel.
 *
 * The architecture is dead simple: Steel sessions expose a CDP WebSocket
 * URL. We connect Playwright via `chromium.connectOverCDP`, grab the
 * resulting Page, and wrap it in a PlaywrightDriver. All bad behavior
 * (cursor overlay, CDP fast-paths, snapshot helper, recovery patterns)
 * works unchanged because PlaywrightDriver doesn't care whether the
 * browser is local or remote.
 *
 * Usage:
 * ```ts
 * import { SteelDriver } from '@tangle-network/browser-agent-driver'
 *
 * const driver = await SteelDriver.create({
 *   apiKey: process.env.STEEL_API_KEY!,
 *   sessionOptions: { useProxy: true, solveCaptcha: true },
 * })
 *
 * const agent = new BrowserAgent({ driver, config: { model: 'sonnet' } })
 * await agent.run({ goal: 'Sign in', startUrl: 'https://app.example.com' })
 * await driver.close()
 * ```
 *
 * To install the Steel SDK without bloating bad's core:
 *   pnpm add steel-sdk
 *
 * The SDK is loaded via dynamic import so users who don't use SteelDriver
 * pay zero cost.
 */

import type { Page, Browser, BrowserContext } from 'playwright'
import type { Driver, ActionResult, ResourceBlockingOptions } from './types.js'
import type { Action, PageState } from '../types.js'
import { PlaywrightDriver, type PlaywrightDriverOptions, type ObserveTiming } from './playwright.js'

/** Provider-specific options grouped under `steel:` to compose with other drivers. */
export interface SteelOptions {
  /** Steel API key. Defaults to STEEL_API_KEY env var. */
  apiKey?: string
  /** Steel API base URL. Defaults to https://api.steel.dev. */
  baseUrl?: string
  /** Optional existing session ID to reuse. If omitted, a new session is created. */
  sessionId?: string
  /**
   * Per-session Steel options. See https://docs.steel.dev for the full schema.
   * Common fields: `useProxy`, `solveCaptcha`, `sessionTimeout`, `region`.
   */
  sessionOptions?: Record<string, unknown>
}

export interface SteelDriverOptions extends PlaywrightDriverOptions {
  /** Steel-specific options. Prefer this nested form over the legacy flat fields. */
  steel?: SteelOptions
  /** @deprecated Use `steel.apiKey` instead. */
  apiKey?: string
  /** @deprecated Use `steel.baseUrl` instead. */
  baseUrl?: string
  /** @deprecated Use `steel.sessionId` instead. */
  sessionId?: string
  /** @deprecated Use `steel.sessionOptions` instead. */
  sessionOptions?: Record<string, unknown>
}

interface SteelSession {
  id: string
  websocketUrl: string
  debugUrl?: string
  sessionViewerUrl?: string
}

interface SteelClient {
  sessions: {
    create: (opts?: Record<string, unknown>) => Promise<SteelSession>
    retrieve: (id: string) => Promise<SteelSession>
    release: (id: string) => Promise<void>
  }
}

/**
 * Driver that runs against a Steel-managed remote browser.
 *
 * Wraps a PlaywrightDriver internally so all of bad's agent behavior works
 * unchanged. Use `SteelDriver.create()` to instantiate — the constructor is
 * private because session setup is async.
 */
export class SteelDriver implements Driver {
  private constructor(
    private readonly inner: PlaywrightDriver,
    private readonly browser: Browser,
    private readonly steelClient: SteelClient,
    private readonly session: SteelSession,
    private readonly ownsSession: boolean,
  ) {}

  /**
   * Create a Steel session and connect Playwright to it.
   *
   * Accepts both the new nested form (`{ steel: { apiKey, ... } }`) and
   * the legacy flat form (`{ apiKey, ... }`). Nested fields win when both
   * are set, so callers can override per-call without losing defaults.
   */
  static async create(options: SteelDriverOptions = {}): Promise<SteelDriver> {
    // Merge legacy flat fields under the nested `steel` shape so the rest
    // of the function only deals with one source of truth.
    const steelOpts: SteelOptions = {
      apiKey: options.steel?.apiKey ?? options.apiKey,
      baseUrl: options.steel?.baseUrl ?? options.baseUrl,
      sessionId: options.steel?.sessionId ?? options.sessionId,
      sessionOptions: options.steel?.sessionOptions ?? options.sessionOptions,
    }

    const apiKey = steelOpts.apiKey ?? process.env.STEEL_API_KEY
    if (!apiKey) {
      throw new Error(
        'SteelDriver: STEEL_API_KEY required (pass options.steel.apiKey or set the env var)',
      )
    }

    // Dynamic import so users who don't use Steel don't need the SDK installed.
    // Use a runtime variable to dodge TypeScript module resolution at compile time.
    const moduleName = 'steel-sdk'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mod: any
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mod = await import(/* @vite-ignore */ moduleName)
    } catch {
      throw new Error(
        'SteelDriver: steel-sdk not installed. Run `pnpm add steel-sdk`.',
      )
    }

    // The real steel-sdk exports `Steel` as a named class. Some forks/older
    // versions used a default export. Try both, throw clearly if neither works.
    type SteelCtor = new (opts: { apiKey: string; baseUrl?: string }) => SteelClient
    const Ctor: SteelCtor | undefined =
      (mod && (mod.Steel as SteelCtor)) ??
      (mod && (mod.default as SteelCtor)) ??
      (typeof mod === 'function' ? (mod as SteelCtor) : undefined)
    if (!Ctor) {
      throw new Error(
        'SteelDriver: steel-sdk export shape not recognized. Expected a `Steel` named export or a default export. Got: ' +
          Object.keys(mod ?? {}).join(', '),
      )
    }
    const steelClient = new Ctor({
      apiKey,
      ...(steelOpts.baseUrl ? { baseUrl: steelOpts.baseUrl } : {}),
    })

    // Reuse an existing session or create a fresh one
    let session: SteelSession
    let ownsSession: boolean
    if (steelOpts.sessionId) {
      session = await steelClient.sessions.retrieve(steelOpts.sessionId)
      ownsSession = false
    } else {
      session = await steelClient.sessions.create(steelOpts.sessionOptions ?? {})
      ownsSession = true
    }

    if (!session.websocketUrl) {
      throw new Error(
        `SteelDriver: session ${session.id} has no websocketUrl — cannot connect Playwright`,
      )
    }

    // Connect Playwright over CDP to the Steel session
    const { chromium } = await import('playwright')
    const browser = await chromium.connectOverCDP(session.websocketUrl)

    // Steel sessions usually have a default context with a default page.
    // Prefer a non-blank page if multiple exist (Steel may leave an
    // about:blank from session warmup alongside the real working page).
    const contexts = browser.contexts()
    let context: BrowserContext
    let page: Page
    if (contexts.length > 0) {
      context = contexts[0]
      const pages = context.pages()
      if (pages.length === 0) {
        page = await context.newPage()
      } else {
        const realPage = pages.find(p => p.url() && p.url() !== 'about:blank')
        page = realPage ?? pages[0]
      }
    } else {
      context = await browser.newContext()
      page = await context.newPage()
    }

    const inner = new PlaywrightDriver(page, options)
    return new SteelDriver(inner, browser, steelClient, session, ownsSession)
  }

  /**
   * The Steel session this driver is connected to. Useful for grabbing the
   * sessionViewerUrl to embed in dashboards or share with teammates.
   */
  getSession(): SteelSession {
    return this.session
  }

  // ── Driver interface — delegate everything to the inner PlaywrightDriver ──
  //
  // We delegate exhaustively (not just the bare Driver interface) so that
  // benchmarks, recovery patterns, screenshot capture, resource blocking,
  // and timing diagnostics all work transparently when callers swap in a
  // SteelDriver. The class-level claim "all bad behavior works unchanged"
  // is only true if we forward every public surface PlaywrightDriver exposes.

  observe(): Promise<PageState> {
    return this.inner.observe()
  }

  execute(action: Action): Promise<ActionResult> {
    return this.inner.execute(action)
  }

  getPage(): Page {
    return this.inner.getPage()
  }

  getUrl(): string {
    return this.inner.getUrl()
  }

  /**
   * Screenshot via the underlying driver so format/quality match
   * PlaywrightDriver (JPEG at the configured quality, not PNG).
   */
  async screenshot(): Promise<Buffer> {
    const state = await this.inner.observe()
    if (state.screenshot) {
      // observe() returned a base64 screenshot — decode it
      return Buffer.from(state.screenshot, 'base64')
    }
    // Fall back to a fresh capture via the page
    return this.inner.getPage().screenshot({ fullPage: false, type: 'jpeg', quality: 50 })
  }

  inspectSelectorHref(selector: string): Promise<string | undefined> {
    return this.inner.inspectSelectorHref(selector)
  }

  /**
   * Apply resource blocking to the remote Steel session — same API as the
   * local driver. Required for benchmarks and any code path that calls it.
   */
  setupResourceBlocking(options: ResourceBlockingOptions): Promise<void> {
    return this.inner.setupResourceBlocking(options)
  }

  /**
   * Phase-level timing from the last observe() call. Required for the
   * benchmark suites in bench/.
   */
  getLastTiming(): ObserveTiming | undefined {
    return this.inner.getLastTiming()
  }

  getDiagnostics(): Record<string, unknown> {
    return {
      driver: 'steel',
      sessionId: this.session.id,
      sessionViewerUrl: this.session.sessionViewerUrl,
      debugUrl: this.session.debugUrl,
    }
  }

  /**
   * Close the Playwright connection and (if we created the session) release
   * it back to Steel. Reused sessions are left alone so the caller can
   * decide their lifetime.
   */
  async close(): Promise<void> {
    try {
      await this.browser.close()
    } catch {
      /* connection may already be dropped */
    }
    if (this.ownsSession) {
      try {
        await this.steelClient.sessions.release(this.session.id)
      } catch {
        /* session may already be expired */
      }
    }
  }

  /**
   * Async dispose support — enables `await using driver = await SteelDriver.create()`
   * in Node 22+ / TypeScript 5.2+. The session is released automatically when
   * the binding goes out of scope, even if an exception is thrown.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }
}
