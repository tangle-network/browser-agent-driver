#!/usr/bin/env node
// Aggregate .evolve/experiments.jsonl to show progress and velocity.
//
// Reads every experiment line, groups by generation/round, computes:
//   - count of experiments per verdict
//   - cumulative wall-clock invested
//   - per-experiment improvement deltas
//   - velocity (experiments per hour, KEEPs per cycle)
//   - what's still pending vs verified
//
// Run: node .evolve/scripts/progress-summary.mjs

import { readFileSync } from 'node:fs'

const lines = readFileSync('.evolve/experiments.jsonl', 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l, i) => {
    try {
      return JSON.parse(l)
    } catch (e) {
      console.error(`Bad JSON line ${i + 1}: ${e.message}`)
      return null
    }
  })
  .filter(Boolean)

if (lines.length === 0) {
  console.log('No experiments yet.')
  process.exit(0)
}

console.log('═══════════════════════════════════════════════════════════════')
console.log(`  Evolve progress: ${lines.length} experiments`)
console.log('═══════════════════════════════════════════════════════════════\n')

// ── Per-experiment table ────────────────────────────────────────────────
console.log('Experiments (chronological)\n')
console.log('  ID         | Gen | Round | Verdict | Δ              | Hypothesis')
console.log('  -----------+-----+-------+---------+----------------+----------------')
for (const e of lines) {
  const id = e.id.padEnd(10)
  const gen = (e.generation ?? '-').toString().padStart(3)
  const round = (e.round ?? '-').toString().padStart(5)
  const verdict = (e.verdict ?? '-').padEnd(7)
  let deltaStr = ''
  if (typeof e.delta === 'number') {
    deltaStr = (e.delta > 0 ? '+' : '') + e.delta.toString()
  }
  deltaStr = deltaStr.padEnd(14)
  const hypothesis = (e.hypothesis ?? '').slice(0, 60)
  console.log(`  ${id} | ${gen} | ${round} | ${verdict} | ${deltaStr} | ${hypothesis}`)
}

// ── Verdict tally ───────────────────────────────────────────────────────
const verdictCounts = {}
for (const e of lines) {
  const v = e.verdict ?? 'UNKNOWN'
  verdictCounts[v] = (verdictCounts[v] ?? 0) + 1
}
console.log('\nVerdict tally')
for (const [v, n] of Object.entries(verdictCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${v.padEnd(8)} ${n}`)
}

// ── Velocity ────────────────────────────────────────────────────────────
const totalDurationMs = lines.reduce((s, e) => s + (e.durationMs ?? 0), 0)
const totalDurationHours = totalDurationMs / 1000 / 3600
const keepRate = (verdictCounts.KEEP ?? 0) / lines.length
const firstTs = new Date(lines[0].timestamp).getTime()
const lastTs = new Date(lines[lines.length - 1].timestamp).getTime()
const wallClockHours = (lastTs - firstTs) / 1000 / 3600

console.log('\nVelocity')
console.log(`  Wall-clock window:    ${wallClockHours.toFixed(2)} hours (first→last experiment)`)
console.log(`  Active work time:     ${totalDurationHours.toFixed(2)} hours (sum of durationMs)`)
console.log(`  Experiments per hour: ${(lines.length / Math.max(totalDurationHours, 0.01)).toFixed(2)} (active)`)
console.log(`  KEEP rate:            ${(keepRate * 100).toFixed(0)}% (${verdictCounts.KEEP ?? 0}/${lines.length})`)

// ── Cumulative wins ─────────────────────────────────────────────────────
console.log('\nCumulative wins (KEEP verdicts only)')
const keeps = lines.filter((e) => e.verdict === 'KEEP')
for (const e of keeps) {
  const learnings = (e.learnings ?? []).slice(0, 1).join(' ') || '(no learnings recorded)'
  console.log(`  · ${e.hypothesis.slice(0, 80)}`)
  console.log(`    └─ ${learnings.slice(0, 100)}`)
}

// ── Generation summary ──────────────────────────────────────────────────
const byGen = {}
for (const e of lines) {
  const g = e.generation ?? 'unversioned'
  if (!byGen[g]) byGen[g] = { count: 0, keeps: 0, rounds: new Set() }
  byGen[g].count++
  if (e.verdict === 'KEEP') byGen[g].keeps++
  if (e.round != null) byGen[g].rounds.add(e.round)
}
console.log('\nBy generation')
for (const [gen, info] of Object.entries(byGen).sort()) {
  const rounds = info.rounds.size > 0 ? `, rounds=${[...info.rounds].sort().join(',')}` : ''
  console.log(`  Gen ${gen}: ${info.count} experiments, ${info.keeps} KEEP${rounds}`)
}

console.log('')
