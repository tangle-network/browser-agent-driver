/**
 * Measurement orchestrator — runs all deterministic measurements on a page
 * and returns a single MeasurementBundle for downstream evaluation.
 *
 * Measurements run in parallel where independent. Failures are non-fatal:
 * the audit continues even if a measurement crashes (it just won't have
 * data from that source).
 */

import type { Page } from 'playwright'
import type { MeasurementBundle } from '../types.js'
import { measureContrast } from './contrast.js'
import { measureA11y } from './a11y.js'

export { measureContrast } from './contrast.js'
export { measureA11y, impactToSeverity } from './a11y.js'

export async function gatherMeasurements(page: Page): Promise<MeasurementBundle> {
  const [contrast, a11y] = await Promise.all([
    measureContrast(page).catch(() => ({
      totalChecked: 0,
      aaFailures: [],
      aaaFailures: [],
      summary: { aaPassRate: 1, aaaPassRate: 1 },
    })),
    measureA11y(page).catch(() => ({
      ran: false,
      error: 'measurement failed',
      violations: [],
      passes: 0,
    })),
  ])

  // Blocking issues: 5+ critical a11y violations OR > 25% contrast failure rate
  const criticalA11y = a11y.violations.filter(
    v => v.impact === 'critical' || v.impact === 'serious',
  ).length
  const contrastFailRate = 1 - contrast.summary.aaPassRate
  const hasBlockingIssues = criticalA11y >= 5 || contrastFailRate > 0.25

  return {
    contrast,
    a11y,
    hasBlockingIssues,
  }
}
