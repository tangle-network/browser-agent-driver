#!/usr/bin/env node
// Aggregate tier1-gate-summary.json across multiple reps and compare baseline vs Gen 4.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function loadAggregate(dir) {
  try {
    const summary = JSON.parse(readFileSync(join(dir, 'tier1-gate-summary.json'), 'utf8'))
    return summary.aggregate
  } catch {
    return null
  }
}

function avg(values) {
  return values.reduce((s, v) => s + v, 0) / values.length
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function stddev(values) {
  const m = avg(values)
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

function summarize(label, dirs) {
  const aggregates = dirs.map(loadAggregate).filter(Boolean)
  if (aggregates.length === 0) {
    console.log(`${label}: no data`)
    return null
  }
  const fullDur = aggregates.map(a => a.fullEvidence.avgDurationMs)
  const fastDur = aggregates.map(a => a.fastExplore.avgDurationMs)
  const fullTokens = aggregates.map(a => a.fullEvidence.avgTokens)
  const fastTokens = aggregates.map(a => a.fastExplore.avgTokens)

  console.log(`\n${label}  (n=${aggregates.length} reps)`)
  console.log(`  fullEvidence:`)
  console.log(`    duration mean=${avg(fullDur).toFixed(0)}ms median=${median(fullDur).toFixed(0)}ms stddev=${stddev(fullDur).toFixed(0)}ms`)
  console.log(`    tokens   mean=${avg(fullTokens).toFixed(0)}`)
  console.log(`  fastExplore:`)
  console.log(`    duration mean=${avg(fastDur).toFixed(0)}ms median=${median(fastDur).toFixed(0)}ms stddev=${stddev(fastDur).toFixed(0)}ms`)
  console.log(`    tokens   mean=${avg(fastTokens).toFixed(0)}`)

  return { fullDur, fastDur, fullTokens, fastTokens }
}

const baseline = summarize('BASELINE (pre-Gen 4)', [
  'agent-results/gen4-baseline',
  'agent-results/gen4-baseline-rep2',
  'agent-results/gen4-baseline-rep3',
])

const gen4 = summarize('GEN 4 (post-changes)', [
  'agent-results/gen4-after',
  'agent-results/gen4-after-rep2',
  'agent-results/gen4-after-rep3',
])

if (baseline && gen4) {
  console.log('\n══ DELTA (Gen 4 vs Baseline) ══')
  const fullDelta = avg(gen4.fullDur) - avg(baseline.fullDur)
  const fastDelta = avg(gen4.fastDur) - avg(baseline.fastDur)
  const fullPct = (fullDelta / avg(baseline.fullDur)) * 100
  const fastPct = (fastDelta / avg(baseline.fastDur)) * 100
  console.log(`  fullEvidence: ${fullDelta > 0 ? '+' : ''}${fullDelta.toFixed(0)}ms (${fullPct > 0 ? '+' : ''}${fullPct.toFixed(1)}%)`)
  console.log(`  fastExplore:  ${fastDelta > 0 ? '+' : ''}${fastDelta.toFixed(0)}ms (${fastPct > 0 ? '+' : ''}${fastPct.toFixed(1)}%)`)

  // Pooled stddev for crude significance check
  const pooledFull = Math.sqrt((stddev(baseline.fullDur) ** 2 + stddev(gen4.fullDur) ** 2) / 2)
  const pooledFast = Math.sqrt((stddev(baseline.fastDur) ** 2 + stddev(gen4.fastDur) ** 2) / 2)
  console.log(`  noise floor (pooled stddev): full=±${pooledFull.toFixed(0)}ms fast=±${pooledFast.toFixed(0)}ms`)
}
