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
import { evaluatePage, type AuditPassId, type AuditOverrides } from './evaluate.js'
import type { PageAuditResult, PageClassification } from './types.js'
import { getTelemetry, shortHash } from '../../telemetry/index.js'
import { loadEthicsRules } from './ethics/loader.js'
import { checkEthics, pageTextBlob } from './ethics/check.js'
import { classifyEnsemble } from './classify-ensemble.js'
import { loadAnchors } from './rubric/anchor-loader.js'
import { buildAuditResultV2 } from './v2/build-result.js'
import type {
  AudienceTag,
  ModalityTag,
  RegulatoryContextTag,
  AudienceVulnerabilityTag,
  EthicsViolation,
  EnsembleClassification,
} from './v2/types.js'

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
  /** Focused LLM audit passes to run for the subjective evaluation layer */
  auditPasses?: AuditPassId[]
  /** Telemetry correlation — links every page envelope to its parent run. */
  runId?: string
  parentRunId?: string
  /** Provider/model — captured into telemetry so a rollup can group by model. */
  provider?: string
  model?: string
  /**
   * Evolve-aware overrides. The GEPA harness passes these per-trial to A/B
   * candidate prompts; production runs leave them undefined.
   */
  overrides?: AuditOverrides
  /**
   * Layer 7 — bypass the ethics gate entirely. Audited + warned. Test-only.
   */
  skipEthics?: boolean
  /** Override directory containing ethics `*.yaml` rule files. */
  ethicsRulesDir?: string
  /** Layer 6 hints used by ethics + composable predicates. */
  audience?: AudienceTag[]
  modality?: ModalityTag[]
  regulatoryContext?: RegulatoryContextTag[]
  audienceVulnerability?: AudienceVulnerabilityTag[]
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
  const {
    brain,
    driver,
    page,
    url,
    profileOverride,
    screenshotDir,
    userRubricsDir,
    auditPasses,
    runId,
    parentRunId,
    provider,
    model,
    overrides,
    skipEthics,
    ethicsRulesDir,
    audience,
    modality,
    regulatoryContext,
    audienceVulnerability,
  } = opts
  const startedAt = Date.now()

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
    // Layer 1: ensemble classifier (URL + DOM + LLM) when no override is set.
    let classification: PageClassification
    let ensemble: EnsembleClassification | undefined
    if (profileOverride) {
      // Build a synthetic classification matching the explicit profile
      classification = {
        ...defaultClassification(),
        type: profileOverride as PageClassification['type'],
        confidence: 1,
      }
    } else {
      ensemble = await classifyEnsemble({ brain, state, url })
      classification = ensemble
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
      auditPasses,
      overrides,
    })

    // ── 7. Ethics gate (Layer 7) — apply rollup floor when rules fire ──
    if (skipEthics) {
      console.warn(`[ethics] --skip-ethics: gate bypassed for ${url} (test-only)`)
      result.ethicsViolations = []
    } else {
      const rules = loadEthicsRules(ethicsRulesDir)
      const ethicsViolations = await checkEthics(
        rules,
        {
          pageText: pageTextBlob(state.snapshot, { url, title: state.title }),
          snapshot: state.snapshot,
          classification,
          audience,
          modality,
          regulatoryContext,
          audienceVulnerability,
        },
        { brain },
      )
      if (ethicsViolations.length > 0) {
        const minCap = Math.min(...ethicsViolations.map((v) => v.rollupCap))
        if (typeof result.score === 'number' && result.score > minCap) {
          result.preEthicsScore = result.score
          result.score = minCap
        }
      }
      result.ethicsViolations = ethicsViolations
    }

    // ── 8. Layer 1 v2 — multi-dim scoring + rollup, emitted alongside v1 ──
    if (ensemble) {
      try {
        const anchors = loadAnchors()
        const anchor = anchors.get(ensemble.type)
        const v2 = await buildAuditResultV2({
          brain,
          state,
          pageRef: url,
          ensemble,
          rubric,
          measurements,
          v1Result: result,
          anchor,
          runId,
        })
        result.auditResultV2 = v2
        result.ensembleClassification = ensemble
      } catch (v2Err) {
        // Don't let v2 failures break v1. Log + move on.
        console.warn(`[audit/v2] failed to build v2 result for ${url}: ${(v2Err as Error).message}`)
      }
    }

    if (runId) {
      const findings = result.findings ?? []
      const ethicsViolations: EthicsViolation[] = result.ethicsViolations ?? []
      getTelemetry().emit({
        kind: 'design-audit-page',
        runId,
        parentRunId,
        ok: !result.error,
        durationMs: Date.now() - startedAt,
        ...(provider && model ? { model: { provider, name: model, rubricHash: shortHash(rubric.body) } } : {}),
        data: {
          url,
          classification,
          rubricFragments: rubric.fragments.map((f) => f.id),
          rubricDimensions: rubric.dimensions,
          auditPasses: auditPasses ?? ['standard'],
          designSystemScore: result.designSystemScore,
          summary: result.summary,
          strengths: result.strengths,
          findings: findings.map((f) => ({
            category: f.category,
            severity: f.severity,
            description: f.description,
            location: f.location,
            cssSelector: f.cssSelector,
            impact: f.impact,
            effort: f.effort,
            blast: f.blast,
          })),
        },
        metrics: {
          score: result.score,
          findingCount: findings.length,
          criticalCount: findings.filter((f) => f.severity === 'critical').length,
          majorCount: findings.filter((f) => f.severity === 'major').length,
          minorCount: findings.filter((f) => f.severity === 'minor').length,
          contrastAaPassRate: measurements.contrast.summary.aaPassRate,
          a11yViolations: measurements.a11y.violations.length,
          tokensUsed: result.tokensUsed ?? 0,
          ethicsViolations: ethicsViolations.length,
          ethicsCriticalFloor: ethicsViolations.filter((v) => v.severity === 'critical-floor').length,
          ethicsMajorFloor: ethicsViolations.filter((v) => v.severity === 'major-floor').length,
        },
        tags: {
          pageType: classification.type,
          domain: classification.domain,
          maturity: classification.maturity,
          designSystem: classification.designSystem,
        },
      })
    }

    return result
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    if (runId) {
      getTelemetry().emit({
        kind: 'design-audit-page',
        runId,
        parentRunId,
        ok: false,
        durationMs: Date.now() - startedAt,
        ...(provider && model ? { model: { provider, name: model } } : {}),
        data: { url },
        metrics: { score: 0, findingCount: 0 },
        error,
      })
    }
    return {
      url,
      score: 0,
      summary: 'Audit failed',
      strengths: [],
      findings: [],
      ethicsViolations: [],
      error,
    }
  }
}
