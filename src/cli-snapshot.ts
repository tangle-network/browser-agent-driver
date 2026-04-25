/**
 * CLI handler for `bad snapshot` — headless, no-LLM accessibility dump.
 *
 * Load URL → dismiss consent → wait for the chosen network state → emit an
 * accessibility-tree snapshot + title + final URL. No scout, no turn loop,
 * no recording. Intended for deterministic DOM-level signal in CI and
 * downstream quality pipelines where the agentic loop is overkill.
 */

import * as fs from 'node:fs'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { dismissModals } from './design/page-interaction.js'
import type { RevealStats } from './design/types.js'
import { cliError } from './cli-ui.js'

type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle' | 'commit'

export interface SnapshotOptions {
  url: string
  /** Output path for JSON. If omitted, stdout. */
  out?: string
  /** Emit JSON. Default false = human-readable text. */
  json?: boolean
  /** Per-action timeout in ms. Default 15000. */
  timeout?: number
  /** Playwright goto waitUntil. Default 'networkidle'. */
  wait?: WaitUntil
  /** Dismiss consent dialogs before snapshotting. Default true. */
  dismissModals?: boolean
  /** Show the browser window. Default false (headless). */
  headed?: boolean
  debug?: boolean
}

export interface SnapshotResult {
  schemaVersion: '1'
  url: string
  finalUrl: string
  title: string
  snapshot: string
  timing: {
    navigateMs: number
    totalMs: number
  }
  dismissed: {
    modals: number
  }
  errors: string[]
}

const WAIT_UNTIL_VALUES: WaitUntil[] = ['load', 'domcontentloaded', 'networkidle', 'commit']

export async function runSnapshot(opts: SnapshotOptions): Promise<SnapshotResult> {
  const waitUntil: WaitUntil = opts.wait && WAIT_UNTIL_VALUES.includes(opts.wait)
    ? opts.wait
    : 'networkidle'
  const timeout = opts.timeout ?? 15_000
  const shouldDismissModals = opts.dismissModals !== false
  const errors: string[] = []
  const started = Date.now()

  let browser: Browser | undefined
  let context: BrowserContext | undefined
  let page: Page | undefined

  try {
    browser = await chromium.launch({ headless: !opts.headed })
    context = await browser.newContext()
    page = await context.newPage()

    const navStarted = Date.now()
    const response = await page.goto(opts.url, { waitUntil, timeout })
    const navigateMs = Date.now() - navStarted

    // Explicit chrome-error surfacing: navigating to a URL that fails at the
    // transport layer (DNS, TLS, network) can leave the page on a
    // chrome-error:// URL with no useful content. Report rather than silently
    // returning an empty snapshot.
    const finalUrl = page.url()
    if (finalUrl.startsWith('chrome-error://')) {
      errors.push(`navigation failed: ${finalUrl}`)
    }
    if (response && !response.ok() && response.status() >= 400) {
      errors.push(`HTTP ${response.status()} ${response.statusText()}`)
    }

    const stats: RevealStats = { accordions: 0, tabs: 0, carousels: 0, hovers: 0, menus: 0, modals: 0 }
    if (shouldDismissModals) {
      await dismissModals(page, stats).catch((err) => {
        errors.push(`dismissModals: ${err instanceof Error ? err.message : String(err)}`)
      })
    }

    const title = await page.title().catch(() => '')
    const snapshot = await page.locator('body').ariaSnapshot({ timeout: 10_000 }).catch((err) => {
      errors.push(`ariaSnapshot: ${err instanceof Error ? err.message : String(err)}`)
      return ''
    })

    return {
      schemaVersion: '1',
      url: opts.url,
      finalUrl: page.url(),
      title,
      snapshot,
      timing: {
        navigateMs,
        totalMs: Date.now() - started,
      },
      dismissed: {
        modals: stats.modals,
      },
      errors,
    }
  } finally {
    await page?.close().catch(() => {})
    await context?.close().catch(() => {})
    await browser?.close().catch(() => {})
  }
}

export async function handleSnapshotCommand(opts: SnapshotOptions): Promise<number> {
  if (!opts.url) {
    cliError('--url is required for snapshot.')
    return 2
  }

  let result: SnapshotResult
  try {
    result = await runSnapshot(opts)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    cliError(`snapshot failed: ${message}`)
    return 1
  }

  const payload = opts.json
    ? JSON.stringify(result, null, 2)
    : formatTextReport(result)

  if (opts.out) {
    fs.writeFileSync(opts.out, payload)
  } else {
    process.stdout.write(payload)
    if (!payload.endsWith('\n')) process.stdout.write('\n')
  }

  return result.errors.length > 0 ? 1 : 0
}

function formatTextReport(result: SnapshotResult): string {
  const lines: string[] = []
  lines.push(`# snapshot`)
  lines.push(`url:        ${result.url}`)
  if (result.finalUrl !== result.url) lines.push(`final_url:  ${result.finalUrl}`)
  lines.push(`title:      ${result.title}`)
  lines.push(`navigate:   ${result.timing.navigateMs}ms`)
  lines.push(`total:      ${result.timing.totalMs}ms`)
  lines.push(`dismissed:  ${result.dismissed.modals} modal(s)`)
  if (result.errors.length > 0) {
    lines.push(`errors:`)
    for (const err of result.errors) lines.push(`  - ${err}`)
  }
  lines.push('')
  lines.push(result.snapshot || '(empty snapshot)')
  return lines.join('\n')
}
