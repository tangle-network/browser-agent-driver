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
import type { Driver, ActionResult } from './types.js'
import type { Action, PageState } from '../types.js'
import { PlaywrightDriver, type PlaywrightDriverOptions } from './playwright.js'

export interface SteelDriverOptions extends PlaywrightDriverOptions {
  /** Steel API key. Defaults to STEEL_API_KEY env var. */
  apiKey?: string
  /** Steel API base URL. Defaults to https://api.steel.dev. */
  baseUrl?: string
  /** Optional existing session ID to reuse. If omitted, a new session is created. */
  sessionId?: string
  /**
   * Per-session Steel options. See https://docs.steel.dev for the full schema.
   * Common fields:
   *   useProxy: enable residential proxy
   *   solveCaptcha: enable CAPTCHA solving
   *   sessionTimeout: max session duration in ms
   *   region: 'us-east' | 'eu-west' | etc.
   */
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
   */
  static async create(options: SteelDriverOptions = {}): Promise<SteelDriver> {
    const apiKey = options.apiKey ?? process.env.STEEL_API_KEY
    if (!apiKey) {
      throw new Error(
        'SteelDriver: STEEL_API_KEY required (pass options.apiKey or set the env var)',
      )
    }

    // Dynamic import so users who don't use Steel don't need the SDK.
    // Use a runtime variable to dodge TypeScript module resolution at compile time.
    const moduleName = 'steel-sdk'
    let SteelSdk: { default: new (opts: { apiKey: string; baseUrl?: string }) => SteelClient }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      SteelSdk = (await import(/* @vite-ignore */ moduleName)) as any
    } catch {
      throw new Error(
        'SteelDriver: steel-sdk not installed. Run `pnpm add steel-sdk`.',
      )
    }

    const Ctor = SteelSdk.default ?? (SteelSdk as unknown as new (opts: { apiKey: string; baseUrl?: string }) => SteelClient)
    const steelClient = new Ctor({
      apiKey,
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    })

    // Reuse an existing session or create a fresh one
    let session: SteelSession
    let ownsSession: boolean
    if (options.sessionId) {
      session = await steelClient.sessions.retrieve(options.sessionId)
      ownsSession = false
    } else {
      session = await steelClient.sessions.create(options.sessionOptions ?? {})
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

    // Steel sessions usually have a default context with a default page
    const contexts = browser.contexts()
    let context: BrowserContext
    let page: Page
    if (contexts.length > 0) {
      context = contexts[0]
      const pages = context.pages()
      page = pages.length > 0 ? pages[0] : await context.newPage()
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

  observe(): Promise<PageState> {
    return this.inner.observe()
  }

  execute(action: Action): Promise<ActionResult> {
    return this.inner.execute(action)
  }

  getPage(): Page | undefined {
    return this.inner.getPage()
  }

  getUrl(): string {
    return this.inner.getUrl()
  }

  async screenshot(): Promise<Buffer> {
    const page = this.inner.getPage()
    if (!page) throw new Error('SteelDriver: no page available for screenshot')
    return page.screenshot({ fullPage: false })
  }

  inspectSelectorHref(selector: string): Promise<string | undefined> {
    return this.inner.inspectSelectorHref(selector)
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
      /* ignore */
    }
    if (this.ownsSession) {
      try {
        await this.steelClient.sessions.release(this.session.id)
      } catch {
        /* session may already be expired */
      }
    }
  }
}
