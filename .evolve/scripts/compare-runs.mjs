#!/usr/bin/env node
// Compare per-turn duration between baseline and Gen 4 runs.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

function loadReport(root) {
  const reportPath = (() => {
    for (const sub of readdirSync(root)) {
      const f = join(root, sub, 'report.json')
      try { readFileSync(f); return f } catch { /* skip */ }
    }
    return null
  })()
  if (!reportPath) return null
  return JSON.parse(readFileSync(reportPath, 'utf8'))
}

function summarize(label, root) {
  const data = loadReport(root)
  if (!data) {
    console.log(`${label}: no report found`)
    return
  }
  const r = data.results?.[0]
  const turns = r?.agentResult?.turns ?? []
  console.log(`\n${label}: ${turns.length} turns, ${r?.durationMs}ms total`)
  for (const [i, t] of turns.entries()) {
    const verified = t.verified === undefined ? '-' : (t.verified ? '✓' : '✗')
    const action = t.action?.action ?? '?'
    console.log(`  ${i.toString().padStart(2)}: ${action.padEnd(12)} dur=${(t.durationMs ?? 0).toString().padStart(5)}ms verified=${verified}  tokens=${t.tokensUsed ?? '-'}`)
  }
}

const args = process.argv.slice(2)
const scenarios = [
  ['form-multistep', 'local-form-multistep'],
  ['dashboard', 'local-dashboard-edit-export'],
]
const modes = ['full-evidence', 'fast-explore']

for (const [name, dir] of scenarios) {
  for (const mode of modes) {
    console.log(`\n══ ${name} / ${mode} ══`)
    summarize('  baseline', `agent-results/gen4-baseline/${dir}/${mode}`)
    summarize('  gen4    ', `agent-results/gen4-after/${dir}/${mode}`)
  }
}
