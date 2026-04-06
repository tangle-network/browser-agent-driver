/**
 * axe-core a11y measurement.
 *
 * Injects axe-core into the page and runs `axe.run()` to get ground-truth
 * WCAG violations. Replaces the LLM's accessibility guesses with the
 * industry-standard rule engine maintained by Deque.
 *
 * axe-core is bundled as a dependency; we read its source from node_modules
 * and inject it via Playwright's `page.addScriptTag` so it works regardless
 * of CSP.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from 'playwright'
import type { A11yReport, A11yViolation } from '../types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Resolve axe-core's bundled JS once per process. Walk up from this file's
// dist location to find node_modules — works in both `dist/` and source layout.
let cachedAxeSource: string | null = null
function getAxeSource(): string {
  if (cachedAxeSource !== null) return cachedAxeSource

  // Try multiple candidate paths because compilation may relocate this file.
  const candidates: string[] = []
  let cursor = __dirname
  for (let i = 0; i < 6; i++) {
    candidates.push(path.join(cursor, 'node_modules/axe-core/axe.min.js'))
    cursor = path.dirname(cursor)
  }

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      cachedAxeSource = fs.readFileSync(c, 'utf-8')
      return cachedAxeSource
    }
  }

  throw new Error('axe-core/axe.min.js not found in any parent node_modules')
}

interface AxeRawResult {
  violations: Array<{
    id: string
    impact: 'critical' | 'serious' | 'moderate' | 'minor' | null
    description: string
    help: string
    helpUrl: string
    tags: string[]
    nodes: Array<{
      target: string[]
      html: string
      failureSummary?: string
    }>
  }>
  passes: Array<unknown>
}

/**
 * Run axe-core against the current page state.
 *
 * Failures of this function are non-fatal — the audit continues without
 * a11y findings if axe can't be injected (e.g., strict CSP).
 */
export async function measureA11y(page: Page): Promise<A11yReport> {
  let axeSource: string
  try {
    axeSource = getAxeSource()
  } catch (err) {
    return {
      ran: false,
      error: err instanceof Error ? err.message : String(err),
      violations: [],
      passes: 0,
    }
  }

  try {
    // Inject axe-core. CSP-strict pages (Stripe, GitHub, etc) block addScriptTag,
    // so we fall back to direct evaluate() which CSP allows because it runs in
    // the puppeteer/playwright extension world, not the page context.
    let injected = false
    try {
      await page.addScriptTag({ content: axeSource })
      injected = true
    } catch {
      // CSP blocked the script tag — try CDP-based bypass
      try {
        const session = await page.context().newCDPSession(page)
        await session.send('Page.addScriptToEvaluateOnNewDocument', { source: axeSource })
        // Reload to apply
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 })
        injected = true
      } catch {
        // CDP failed too — last resort: inject via evaluate (works on most CSP configs)
        await page.evaluate((src: string) => {
          // eslint-disable-next-line @typescript-eslint/no-implied-eval
          new Function(src)()
        }, axeSource)
        injected = true
      }
    }

    if (!injected) {
      return {
        ran: false,
        error: 'all injection methods failed (CSP)',
        violations: [],
        passes: 0,
      }
    }

    // Run with WCAG 2.1 AA tags. Limit nodes per violation to keep payload manageable.
    const raw = (await page.evaluate(async () => {
      const w = window as unknown as {
        axe?: {
          run: (
            ctx: Document,
            opts: { runOnly: { type: string; values: string[] }; resultTypes: string[] },
          ) => Promise<unknown>
        }
      }
      if (!w.axe) {
        throw new Error('axe not loaded after injection')
      }
      return w.axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
        resultTypes: ['violations', 'passes'],
      })
    })) as AxeRawResult

    const violations: A11yViolation[] = raw.violations.map(v => ({
      id: v.id,
      impact: v.impact ?? 'moderate',
      description: v.description || v.help,
      tags: v.tags,
      helpUrl: v.helpUrl,
      nodes: v.nodes.slice(0, 5).map(n => ({
        selector: Array.isArray(n.target) ? n.target.join(' ') : String(n.target),
        html: (n.html ?? '').slice(0, 200),
        failureSummary: (n.failureSummary ?? '').slice(0, 300),
      })),
    }))

    return {
      ran: true,
      violations,
      passes: raw.passes.length,
    }
  } catch (err) {
    return {
      ran: false,
      error: err instanceof Error ? err.message : String(err),
      violations: [],
      passes: 0,
    }
  }
}

/**
 * Map axe impact level to our DesignFinding severity scale.
 */
export function impactToSeverity(impact: A11yViolation['impact']): 'critical' | 'major' | 'minor' {
  switch (impact) {
    case 'critical':
    case 'serious':
      return 'critical'
    case 'moderate':
      return 'major'
    case 'minor':
    default:
      return 'minor'
  }
}
