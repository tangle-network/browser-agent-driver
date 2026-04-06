/**
 * Audit pipeline — orchestrates the full Gen 2 audit for one page.
 *
 *   load page → classify → compose rubric → measure → evaluate → result
 *
 * The pipeline is the only place that knows about all stages. Each stage is
 * a pure function elsewhere in this module — easy to unit test in isolation.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Page } from 'playwright'
import type { Brain } from '../../brain/index.js'
import { PlaywrightDriver } from '../../drivers/playwright.js'
import { classifyPage, defaultClassification } from './classify.js'
import { composeRubric, composeRubricFromProfile } from './rubric/loader.js'
import { gatherMeasurements } from './measure/index.js'
import { evaluatePage } from './evaluate.js'
import type { PageAuditResult, PageClassification } from './types.js'

export interface AuditOnePageOptions {
  brain: Brain
  driver: PlaywrightDriver
  page: Page
  url: string
  /** When set, skip classification and use this profile fragment directly */
  profileOverride?: string
  /** Directory to save the screenshot (skipped when undefined) */
  screenshotDir?: string
  /** User-supplied rubric fragments directory */
  userRubricsDir?: string
}

const COOKIE_BANNER_SELECTORS = [
  'button:has-text("Accept all")',
  'button:has-text("Accept")',
  'button:has-text("Reject all")',
  'button:has-text("Got it")',
  'button:has-text("Close")',
]

async function dismissCookieBanners(page: Page): Promise<void> {
  for (const sel of COOKIE_BANNER_SELECTORS) {
    const btn = page.locator(sel).first()
    if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
      await btn.click({ timeout: 2000 }).catch(() => null)
      await page.waitForTimeout(500)
      return
    }
  }
}

/**
 * Audit one page through the full Gen 2 pipeline.
 */
export async function auditOnePage(opts: AuditOnePageOptions): Promise<PageAuditResult> {
  const { brain, driver, page, url, profileOverride, screenshotDir, userRubricsDir } = opts

  try {
    // ── 1. Load the page ──
    await page
      .goto(url, { waitUntil: 'networkidle', timeout: 20_000 })
      .catch(() => page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 }))
    await page.waitForTimeout(2000)
    await dismissCookieBanners(page)

    const state = await driver.observe()

    // ── 2. Save screenshot ──
    let screenshotPath: string | undefined
    if (screenshotDir) {
      const slug = new URL(url).pathname.replace(/\//g, '_').replace(/^_/, '') || 'index'
      screenshotPath = path.join(screenshotDir, `${slug}.png`)
      await page.screenshot({ path: screenshotPath, fullPage: false })
    }

    // ── 3. Classify (or use profile override) ──
    let classification: PageClassification
    if (profileOverride) {
      // Build a synthetic classification matching the explicit profile
      classification = {
        ...defaultClassification(),
        type: profileOverride as PageClassification['type'],
        confidence: 1,
      }
    } else {
      classification = await classifyPage(brain, state)
    }

    // ── 4. Compose rubric ──
    const rubric = profileOverride
      ? composeRubricFromProfile(profileOverride)
      : composeRubric(classification, undefined, userRubricsDir)

    // Confidence fallback: if classifier isn't confident, fall back to general
    if (!profileOverride && classification.confidence < 0.5) {
      // Re-compose with universal-only fragments
      const fallbackClass: PageClassification = {
        ...classification,
        type: 'unknown',
      }
      Object.assign(rubric, composeRubric(fallbackClass, undefined, userRubricsDir))
    }

    // ── 5. Measure (deterministic, runs in parallel) ──
    const measurements = await gatherMeasurements(page)

    // ── 6. Evaluate ──
    const result = await evaluatePage(brain, {
      url,
      state,
      classification,
      rubric,
      measurements,
      screenshotPath,
    })

    return result
  } catch (err) {
    return {
      url,
      score: 0,
      summary: 'Audit failed',
      strengths: [],
      findings: [],
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Persist a `PageAuditResult` to JSON for downstream tooling.
 */
export function writeResultJson(result: PageAuditResult, dir: string): void {
  const slug = new URL(result.url).hostname.replace(/[^a-z0-9.-]/gi, '_')
  fs.writeFileSync(path.join(dir, `${slug}-${Date.now()}.json`), JSON.stringify(result, null, 2))
}
