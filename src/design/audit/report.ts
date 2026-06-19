/**
 * Design Audit report renderer.
 *
 * Turns scored page-audit results into the markdown report, plus the
 * terminal print/format helpers the design-audit CLI handler uses to
 * surface scores and ethics violations.
 */

import chalk from 'chalk'
import type { DesignFinding } from '../../types.js'
import type { EthicsViolation } from './types.js'
import type { PageAuditResult } from '../../cli-design-audit.js'

/** Split "a, b , c" → ['a','b','c']. Returns undefined for empty input so the
 *  layered predicates can distinguish "operator did not say" from "[]". */
export function parseTagList(input: string | undefined): string[] | undefined {
  if (!input) return undefined
  const tags = input.split(',').map(s => s.trim()).filter(Boolean)
  return tags.length > 0 ? tags : undefined
}

/** Pretty-print the ethics-violation report for a set of pages. Prints
 *  nothing when no page tripped a rule. Each rule is shown with severity,
 *  remediation, and citation so the operator can act without re-running. */
export function printEthicsViolations(pages: Array<{ url: string; ethicsViolations?: EthicsViolation[] }>): void {
  const offenders = pages.filter(p => (p.ethicsViolations?.length ?? 0) > 0)
  if (offenders.length === 0) return
  console.log('')
  console.log(`  ${chalk.bgRed.white.bold(' ETHICS VIOLATIONS ')}`)
  for (const page of offenders) {
    console.log(`  ${chalk.dim('Page:')} ${page.url}`)
    for (const v of page.ethicsViolations ?? []) {
      const sevColor = v.severity === 'critical-floor' ? chalk.red : chalk.yellow
      console.log(`    ${sevColor('•')} ${chalk.bold(v.ruleId)} ${chalk.dim('—')} ${sevColor(v.severity)} ${chalk.dim(`(rollup capped at ${v.rollupCap})`)}`)
      console.log(`      ${chalk.dim('fix:')} ${v.remediation}`)
      if (v.citation) console.log(`      ${chalk.dim('cite:')} ${v.citation}`)
    }
  }
}

/** Lowest rollup cap across all violated pages, or undefined if none fired. */
export function lowestRollupCap(pages: Array<{ ethicsViolations?: EthicsViolation[] }>): number | undefined {
  const caps = pages.flatMap(p => p.ethicsViolations ?? []).map(v => v.rollupCap)
  return caps.length === 0 ? undefined : Math.min(...caps)
}

/**
 * Layer 1 — print the per-dimension breakdown for one page when an
 * `auditResult` is attached. Five dim lines + one rollup line; each shows
 * score, range, and confidence so an agent can reason about uncertainty.
 */
export function printScoreBreakdown(page: { auditResult?: unknown }): void {
  const result = page.auditResult as
    | {
        scores?: Record<string, { score: number; range: [number, number]; confidence: string }>
        rollup?: { score: number; range: [number, number]; confidence: string; rule: string }
      }
    | undefined
  if (!result || !result.scores || !result.rollup) return

  const dimOrder = ['product_intent', 'visual_craft', 'trust_clarity', 'workflow', 'content_ia']
  for (const dim of dimOrder) {
    const s = result.scores[dim]
    if (!s) continue
    const sevColor = s.score >= 8 ? chalk.green : s.score >= 5 ? chalk.yellow : chalk.red
    const confColor = s.confidence === 'high' ? chalk.green : s.confidence === 'medium' ? chalk.yellow : chalk.dim
    console.log(
      `      ${chalk.dim(dim.padEnd(15))} ${sevColor(`${s.score}/10`)} ${chalk.dim(`[${s.range[0]}-${s.range[1]}]`)} ${confColor(s.confidence)}`,
    )
  }
  const r = result.rollup
  const rColor = r.score >= 8 ? chalk.green : r.score >= 5 ? chalk.yellow : chalk.red
  const confColor = r.confidence === 'high' ? chalk.green : r.confidence === 'medium' ? chalk.yellow : chalk.dim
  console.log(
    `      ${chalk.dim('rollup'.padEnd(15))} ${rColor(`${r.score.toFixed(1)}/10`)} ${chalk.dim(`[${r.range[0].toFixed(1)}-${r.range[1].toFixed(1)}]`)} ${confColor(r.confidence)}  ${chalk.dim(r.rule)}`,
  )
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

function generateReport(
  results: PageAuditResult[],
  profile: string | undefined,
  topFixes: DesignFinding[] = [],
  redesignSection?: string,
): string {
  const lines: string[] = []
  const avgScore = results.length > 0
    ? results.reduce((sum, r) => sum + r.score, 0) / results.length
    : 0

  const allFindings = results.flatMap(r => r.findings)
  const critical = allFindings.filter(f => f.severity === 'critical').length
  const major = allFindings.filter(f => f.severity === 'major').length
  const minor = allFindings.filter(f => f.severity === 'minor').length
  const totalTokens = results.reduce((sum, r) => sum + (r.tokensUsed ?? 0), 0)

  lines.push('# Design Audit Report')
  lines.push('')
  if (profile) {
    lines.push(`**Profile:** ${profile}`)
  }
  // Surface per-page classification when present.
  const classifications = results
    .filter(r => r.classification)
    .map(r => `${r.url}: ${r.classification!.type}/${r.classification!.domain} (${r.classification!.maturity})`)
  if (classifications.length > 0) {
    lines.push(`**Auto-classified:**`)
    for (const c of classifications) lines.push(`- ${c}`)
  }
  lines.push(`**Pages audited:** ${results.length}`)
  lines.push(`**Overall score:** ${avgScore.toFixed(1)}/10`)
  lines.push(`**Findings:** ${allFindings.length} (${critical} critical, ${major} major, ${minor} minor)`)
  if (totalTokens > 0) lines.push(`**Tokens used:** ${totalTokens.toLocaleString()}`)
  lines.push('')

  // Score bar
  const scoreBar = '█'.repeat(Math.round(avgScore)) + '░'.repeat(10 - Math.round(avgScore))
  lines.push(`\`${scoreBar}\` ${avgScore.toFixed(1)}/10`)
  lines.push('')

  // ── Top Fixes (by ROI) — the headline section users actually read first ──
  if (topFixes.length > 0) {
    lines.push('## Top Fixes (by ROI)')
    lines.push('')
    lines.push('Fix these first — sorted by impact × blast / effort:')
    lines.push('')
    for (let i = 0; i < topFixes.length; i++) {
      const f = topFixes[i]
      const tags: string[] = []
      if (f.pageCount && f.pageCount >= 2) tags.push(`appears on ${f.pageCount} pages`)
      if (f.blast === 'system') tags.push('SYSTEMIC')
      const tagStr = tags.length > 0 ? ` _(${tags.join(', ')})_` : ''
      const roiStr = f.roi !== undefined ? f.roi.toFixed(1) : '—'
      lines.push(`### ${i + 1}. [${f.severity}] ${f.description}${tagStr}`)
      lines.push('')
      lines.push(`- **ROI:** ${roiStr}  ·  Impact ${f.impact ?? '—'}  ·  Effort ${f.effort ?? '—'}  ·  Blast ${f.blast ?? '—'}`)
      lines.push(`- **Location:** ${f.location}`)
      lines.push(`- **Fix:** ${f.suggestion}`)
      if (f.cssSelector && f.cssFix) {
        lines.push(`- **CSS:** \`${f.cssSelector} { ${f.cssFix} }\``)
      }
      lines.push('')
    }
    lines.push('---')
    lines.push('')
  }

  // ── Redesign directions (reference-grounded mode only) — a pre-rendered,
  // compact projection of the rich artifact: winner in brief + ranked alternates,
  // pointing at the full `<slug>.redesign.md`. Undefined on the v1 path, so the
  // default report stays byte-identical. ──
  if (redesignSection) {
    lines.push(redesignSection)
    lines.push('')
    lines.push('---')
    lines.push('')
  }

  // Per-page results
  for (const result of results) {
    lines.push(`## ${result.url}`)
    lines.push('')
    const pageBar = '█'.repeat(Math.round(result.score)) + '░'.repeat(10 - Math.round(result.score))
    lines.push(`**Score:** \`${pageBar}\` ${result.score}/10`)
    if (result.summary) lines.push(`**Summary:** ${result.summary}`)
    if (result.error) lines.push(`**Error:** ${result.error}`)
    lines.push('')

    if (result.strengths.length > 0) {
      lines.push('**Strengths:**')
      for (const s of result.strengths) lines.push(`- ${s}`)
      lines.push('')
    }

    if (result.designSystemScore) {
      lines.push('**Design System Breakdown:**')
      lines.push('')
      const ds = result.designSystemScore
      // Universal dimensions in fixed order, then any custom dimensions (alpha)
      const universal = ['layout', 'typography', 'color', 'spacing', 'components', 'interactions', 'accessibility', 'polish']
      const custom = Object.keys(ds).filter(k => !universal.includes(k)).sort()
      for (const key of [...universal, ...custom]) {
        if (typeof ds[key] === 'number') {
          const bar = '█'.repeat(Math.round(ds[key])) + '░'.repeat(10 - Math.round(ds[key]))
          lines.push(`- ${key}: \`${bar}\` ${ds[key]}/10`)
        }
      }
      lines.push('')
    }

    if (result.findings.length > 0) {
      lines.push('**Findings:**')
      lines.push('')
      lines.push('| Sev | Category | Description | Location | Fix | CSS |')
      lines.push('|-----|----------|-------------|----------|-----|-----|')
      for (const f of result.findings) {
        const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 120)
        const icon = f.severity === 'critical' ? '🔴' : f.severity === 'major' ? '🟡' : '⚪'
        const cssFix = f.cssFix ? `\`${esc(f.cssFix)}\`` : ''
        lines.push(`| ${icon} ${f.severity} | ${f.category} | ${esc(f.description)} | ${esc(f.location)} | ${esc(f.suggestion)} | ${cssFix} |`)
      }
      lines.push('')
    } else if (!result.error) {
      lines.push('No issues found.')
      lines.push('')
    }
  }

  return lines.join('\n')
}

// Exported under a distinct name to avoid clashing with test-report.ts's
// unrelated `generateReport`. Internal name kept for parity with prior history.
export { generateReport as generateDesignReport }
