#!/usr/bin/env node
// Count decide-* events from events.jsonl files to measure the real-world
// LLM-skip rate of the Gen 5 decision cache + deterministic patterns.
//
// Usage: node .evolve/scripts/count-decide-events.mjs <events.jsonl> [...]

import { readFileSync } from 'node:fs'
import path from 'node:path'

if (process.argv.length < 3) {
  console.error('Usage: count-decide-events.mjs <events.jsonl> [<events.jsonl>...]')
  process.exit(1)
}

let totals = {
  files: 0,
  events: 0,
  decideStarted: 0,
  decideCompleted: 0,
  decideSkippedCached: 0,
  decideSkippedPattern: 0,
  recoveryFired: 0,
  overrideApplied: 0,
}

for (const file of process.argv.slice(2)) {
  totals.files++
  const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean)
  let perFile = {
    events: 0,
    decideStarted: 0,
    decideCompleted: 0,
    decideSkippedCached: 0,
    decideSkippedPattern: 0,
    recoveryFired: 0,
    overrideApplied: 0,
  }
  for (const line of lines) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    perFile.events++
    if (event.type === 'decide-started') perFile.decideStarted++
    if (event.type === 'decide-completed') perFile.decideCompleted++
    if (event.type === 'decide-skipped-cached') perFile.decideSkippedCached++
    if (event.type === 'decide-skipped-pattern') perFile.decideSkippedPattern++
    if (event.type === 'recovery-fired') perFile.recoveryFired++
    if (event.type === 'override-applied') perFile.overrideApplied++
  }
  console.log(`\n${path.relative(process.cwd(), file)}`)
  console.log(`  events:                 ${perFile.events}`)
  console.log(`  decide-started (total): ${perFile.decideStarted}`)
  console.log(`  decide-completed (LLM): ${perFile.decideCompleted}`)
  console.log(`  decide-skipped-cached:  ${perFile.decideSkippedCached}`)
  console.log(`  decide-skipped-pattern: ${perFile.decideSkippedPattern}`)
  console.log(`  recovery-fired:         ${perFile.recoveryFired}`)
  console.log(`  override-applied:       ${perFile.overrideApplied}`)
  // decide-started is the canonical "decision phase entered" count.
  // decide-completed only fires for LLM-actually-called paths.
  const totalDecisions = perFile.decideStarted
  if (totalDecisions > 0) {
    const skipped = perFile.decideSkippedCached + perFile.decideSkippedPattern
    const skipRate = (skipped / totalDecisions * 100).toFixed(1)
    console.log(`  ↳ LLM skip rate:        ${skipped}/${totalDecisions} = ${skipRate}%`)
  }

  totals.events += perFile.events
  totals.decideStarted += perFile.decideStarted
  totals.decideCompleted += perFile.decideCompleted
  totals.decideSkippedCached += perFile.decideSkippedCached
  totals.decideSkippedPattern += perFile.decideSkippedPattern
  totals.recoveryFired += perFile.recoveryFired
  totals.overrideApplied += perFile.overrideApplied
}

console.log('\n══════════════════════════════════════════')
console.log(`AGGREGATE across ${totals.files} file(s)`)
console.log('══════════════════════════════════════════')
console.log(`  total events:           ${totals.events}`)
console.log(`  decide-started (total): ${totals.decideStarted}`)
console.log(`  decide-completed (LLM): ${totals.decideCompleted}`)
console.log(`  decide-skipped-cached:  ${totals.decideSkippedCached}`)
console.log(`  decide-skipped-pattern: ${totals.decideSkippedPattern}`)
console.log(`  recovery-fired:         ${totals.recoveryFired}`)
console.log(`  override-applied:       ${totals.overrideApplied}`)
const totalDecisions = totals.decideStarted
if (totalDecisions > 0) {
  const skipped = totals.decideSkippedCached + totals.decideSkippedPattern
  const skipRate = (skipped / totalDecisions * 100).toFixed(1)
  console.log(`  ↳ LLM skip rate:        ${skipped}/${totalDecisions} = ${skipRate}%`)
}
