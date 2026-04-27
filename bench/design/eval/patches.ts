/**
 * Patches evaluator: when the audit emits a Patch, is `diff.before` actually
 * present in the page snapshot? If not, the agent will paste-replace
 * non-existent text and corrupt the file.
 *
 * Reuses `validatePatch` from src/design/audit/patches/validate.ts so the
 * eval shares the exact same logic the runner uses to enforce severity
 * downgrades. Drift between the two would silently make this metric lie.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { FlowEnvelope } from './scorecard.js'
import { statusFor } from './scorecard.js'
import { validatePatch, type ValidationReason } from '../../../src/design/audit/patches/validate.js'
import type { DesignFinding } from '../../../src/design/audit/score-types.js'

export interface PatchEvalOptions {
  /** Roots to scan for `report.json` files. */
  roots: string[]
  /** Pass/fail threshold on the valid-rate. Default 0.95 (95% of patches must validate). */
  target?: number
}

const FLOW_NAME = 'designAudit_patches_valid_rate'

export function evaluatePatches(opts: PatchEvalOptions): FlowEnvelope {
  const target = opts.target ?? 0.95
  let total = 0
  let valid = 0
  const failures: Array<{ report: string; patchId: string; reasons: ValidationReason[] }> = []

  for (const root of opts.roots) {
    if (!fs.existsSync(root)) continue
    for (const reportJson of walkReportJsons(root)) {
      const data = readReport(reportJson)
      if (!data) continue
      const snapshot = data.snapshot ?? ''
      const findings: DesignFinding[] = data.findings ?? []
      for (const f of findings) {
        for (const p of f.patches ?? []) {
          total += 1
          const v = validatePatch(p, snapshot)
          if (v.valid) valid += 1
          else failures.push({ report: reportJson, patchId: p.patchId, reasons: v.reasons })
        }
      }
    }
  }

  const score = total === 0 ? NaN : valid / total
  return {
    name: FLOW_NAME,
    description: 'Fraction of audit-emitted patches whose diff.before is present in the page snapshot.',
    score,
    target,
    comparator: '>=',
    status: total === 0 ? 'unmeasured' : statusFor(score, target, '>='),
    notes: total === 0
      ? 'no patches emitted across the scanned reports — eval is unmeasured this round'
      : `${valid}/${total} patches valid${failures.length ? `, ${failures.length} failures` : ''}`,
    detail: { total, valid, failures: failures.slice(0, 10) },
  }
}

function* walkReportJsons(root: string): Generator<string> {
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()!
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(current, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const full = path.join(current, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.isFile() && e.name === 'report.json') yield full
    }
  }
}

interface RawReport {
  snapshot?: string
  pages?: Array<{ snapshot?: string; findings?: DesignFinding[]; auditResult?: { findings?: DesignFinding[] } }>
}

function readReport(reportJson: string): { snapshot: string; findings: DesignFinding[] } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(reportJson, 'utf-8')) as RawReport
    const page = raw.pages?.[0]
    if (!page) return null
    const snapshot = page.snapshot ?? raw.snapshot ?? ''
    const findings = page.auditResult?.findings ?? page.findings ?? []
    return { snapshot, findings: findings as DesignFinding[] }
  } catch {
    return null
  }
}
