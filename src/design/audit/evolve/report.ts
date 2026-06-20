import type { DesignEvolveResult } from '../../../types.js'

export function generateEvolveReport(result: DesignEvolveResult): string {
  const lines: string[] = []
  lines.push('# Design Evolve Report')
  lines.push('')
  // Sign the delta explicitly — a regression (negative delta) must not render as "(+-1.5)".
  const sign = result.delta >= 0 ? '+' : ''
  lines.push(`**Score:** ${result.beforeScore.toFixed(1)} → ${result.afterScore.toFixed(1)} (${sign}${result.delta.toFixed(1)})`)
  lines.push(`**Rounds:** ${result.rounds}`)
  lines.push(`**Score progression:** ${result.scoreHistory.map(s => s.toFixed(1)).join(' → ')}`)
  lines.push('')

  if (result.appliedFixes.length > 0) {
    lines.push('## Applied Fixes')
    lines.push('')
    for (const fix of result.appliedFixes) {
      lines.push(`- \`${fix.cssSelector}\`: \`${fix.cssFix}\``)
      if (fix.finding) lines.push(`  - ${fix.finding}`)
    }
    lines.push('')
  }

  // Skipped fixes carry a reason; surfacing them tells the operator which
  // generated fixes were dropped and why (data omission otherwise).
  if (result.skippedFixes.length > 0) {
    lines.push('## Skipped Fixes')
    lines.push('')
    for (const fix of result.skippedFixes) {
      lines.push(`- \`${fix.cssSelector}\`: \`${fix.cssFix}\` — ${fix.reason}`)
    }
    lines.push('')
  }

  if (result.cssOverride) {
    lines.push('## Generated CSS Override')
    lines.push('')
    lines.push('```css')
    lines.push(result.cssOverride)
    lines.push('```')
    lines.push('')
    lines.push('Apply this CSS to your app to fix the identified design issues:')
    lines.push('```html')
    lines.push('<link rel="stylesheet" href="design-fixes.css">')
    lines.push('```')
  }

  return lines.join('\n')
}
