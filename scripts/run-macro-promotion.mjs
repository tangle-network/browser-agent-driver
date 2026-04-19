#!/usr/bin/env node
/**
 * Macro promotion script — Gen 29 eval-gated mutable tool surface.
 *
 * Reads a candidate under `.evolve/candidates/macros/*.json`, stages its
 * macro into a tmpdir (so the canonical `skills/macros/` tree is never
 * mutated by the promotion run), runs the candidate's referenced bench
 * case `--reps N` times with and without the macro registered, and
 * produces a verdict table.
 *
 * Auto-promote only when --auto-promote is passed AND the verdict is
 * "promote". Rejects move to `.evolve/candidates/rejected/<name>-<date>.md`
 * with the full measurement table so the operator can triage.
 *
 * The candidate JSON shape:
 *
 *   {
 *     "macro": { ...MacroDefinition shape... },
 *     "eval": {
 *       "benchCase": "bench/scenarios/cases/<file>.json",
 *       "config":    "bench/scenarios/configs/<file>.mjs",
 *       "modes":     "fast-explore",
 *       "reps":      3,
 *       "successCriteria": {
 *         "minPassRate": 1.0,
 *         "maxTurnsMean": 10
 *       }
 *     },
 *     "rationale": "…human or agent-provided reason…"
 *   }
 *
 * Usage:
 *   node scripts/run-macro-promotion.mjs --candidate .evolve/candidates/macros/dismiss-cookie-banner.json
 *   node scripts/run-macro-promotion.mjs --all                       # iterate every candidate
 *   node scripts/run-macro-promotion.mjs --candidate ... --auto-promote
 *
 * Exit codes:
 *   0 = ran successfully (regardless of verdict)
 *   1 = bad inputs, IO failure, or subprocess crash
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { compare, decideVerdict } from './lib/macro-promotion.mjs'

// Must match src/skills/macro-loader.ts SAFE_MACRO_NAME. Enforced here so a
// malicious candidate with name="../etc/passwd" can't clobber arbitrary paths
// relative to skills/macros/ during auto-promote. Defined at module top-level
// to avoid temporal-dead-zone in the candidate-iteration loop below.
const SAFE_MACRO_NAME_REGEX = /^[a-z][a-z0-9-]*$/i

const argv = process.argv.slice(2)
const getArg = (name, fallback) => {
  const idx = argv.indexOf(`--${name}`)
  if (idx === -1) return fallback
  if (idx === argv.length - 1) return 'true'
  return argv[idx + 1]
}
const hasFlag = (name) => argv.includes(`--${name}`)

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const candidatePath = getArg('candidate')
const runAll = hasFlag('all')
const autoPromote = hasFlag('auto-promote')
const verbose = hasFlag('verbose')

if (!candidatePath && !runAll) {
  console.error('Usage: node scripts/run-macro-promotion.mjs --candidate <path> [--auto-promote]')
  console.error('       node scripts/run-macro-promotion.mjs --all [--auto-promote]')
  process.exit(1)
}

const candidatesRoot = path.join(rootDir, '.evolve', 'candidates', 'macros')
const rejectedRoot = path.join(rootDir, '.evolve', 'candidates', 'rejected')
const experimentsPath = path.join(rootDir, '.evolve', 'experiments.jsonl')
const skillsRoot = path.join(rootDir, 'skills', 'macros')

fs.mkdirSync(rejectedRoot, { recursive: true })
fs.mkdirSync(path.dirname(experimentsPath), { recursive: true })

// Track any in-flight staging dir so Ctrl-C during a multi-rep doesn't leak
// hundreds of megabytes of report artifacts in /tmp. Registered lazily so
// the "nothing to do" path doesn't install an orphan handler.
const activeStagingDirs = new Set()
let interrupted = false
function onSignal(sig) {
  interrupted = true
  for (const dir of activeStagingDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
  process.exit(sig === 'SIGINT' ? 130 : 143)
}
process.on('SIGINT', () => onSignal('SIGINT'))
process.on('SIGTERM', () => onSignal('SIGTERM'))

const candidateFiles = runAll
  ? fs.existsSync(candidatesRoot)
    ? fs.readdirSync(candidatesRoot).filter((f) => f.endsWith('.json')).map((f) => path.join(candidatesRoot, f))
    : []
  : [path.resolve(candidatePath)]

if (candidateFiles.length === 0) {
  console.error('No candidates to promote.')
  process.exit(0)
}

const overallResults = []

for (const file of candidateFiles) {
  const name = path.basename(file, '.json')
  console.log(`\n=== candidate: ${name} (${file}) ===`)
  try {
    const outcome = await evaluateCandidate(file)
    overallResults.push({ name, ...outcome })
    const mdLine = `${name}: ${outcome.verdict}`
    console.log(`\n${mdLine}`)
  } catch (err) {
    console.error(`  FAILED: ${err.message}`)
    overallResults.push({ name, verdict: 'error', error: err.message })
  }
}

console.log('\n=== Promotion summary ===')
for (const r of overallResults) {
  console.log(`  ${r.name.padEnd(40)} ${r.verdict}`)
}

process.exit(0)

// ── Core logic ────────────────────────────────────────────────────────────

async function evaluateCandidate(candidateFile) {
  const candidate = JSON.parse(fs.readFileSync(candidateFile, 'utf-8'))
  validateCandidate(candidate, candidateFile)

  const macro = candidate.macro
  const evalSpec = candidate.eval
  const name = macro.name
  const benchCase = path.resolve(rootDir, evalSpec.benchCase)
  const config = evalSpec.config ? path.resolve(rootDir, evalSpec.config) : undefined
  const reps = Math.max(1, Number.parseInt(evalSpec.reps ?? '3', 10))
  const modes = evalSpec.modes ?? 'fast-explore'

  if (!fs.existsSync(benchCase)) {
    throw new Error(`benchCase not found: ${benchCase}`)
  }

  // Stage the macro in a fresh tmp dir so the canonical skills/macros tree
  // is never mutated by the promotion pass. BAD_MACROS_DIR tells the loader
  // to read from here instead of the default location.
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), `bad-macro-promo-${name}-`))
  activeStagingDirs.add(stagingDir)
  try {
    // Treatment — macro is available to the agent
    const treatmentMacroPath = path.join(stagingDir, `${name}.json`)
    fs.writeFileSync(treatmentMacroPath, JSON.stringify(macro, null, 2))
    const treatmentOut = path.join(rootDir, '.evolve', 'candidates', 'runs', `${name}-treatment-${Date.now()}`)
    const treatmentSummary = await runMultiRep({
      label: `promo-${name}-treatment`,
      cases: benchCase,
      config,
      reps,
      modes,
      out: treatmentOut,
      env: { ...process.env, BAD_MACROS_DIR: stagingDir },
    })

    // Baseline — macro is NOT available. BAD_MACROS_DISABLED ensures the
    // loader produces an empty registry regardless of what's on disk.
    const baselineOut = path.join(rootDir, '.evolve', 'candidates', 'runs', `${name}-baseline-${Date.now()}`)
    const baselineSummary = await runMultiRep({
      label: `promo-${name}-baseline`,
      cases: benchCase,
      config,
      reps,
      modes,
      out: baselineOut,
      env: { ...process.env, BAD_MACROS_DISABLED: '1' },
    })

    const comparison = compare(baselineSummary, treatmentSummary)
    const verdict = decideVerdict(comparison, evalSpec.successCriteria)
    const table = renderComparisonTable(name, comparison, verdict)
    console.log(table)

    // Persist the comparison artifact unconditionally so we have a paper
    // trail even when auto-promote is off.
    fs.writeFileSync(path.join(treatmentOut, 'comparison.md'), table)

    if (verdict === 'promote') {
      if (autoPromote) {
        fs.mkdirSync(skillsRoot, { recursive: true })
        const promotedPath = path.join(skillsRoot, `${name}.json`)
        fs.writeFileSync(promotedPath, JSON.stringify(macro, null, 2))
        fs.unlinkSync(candidateFile)
        appendExperimentLog({
          generation: 29,
          event: 'macro-promoted',
          name,
          rationale: candidate.rationale ?? '',
          verdict: comparison,
          promotedFrom: candidateFile,
          promotedTo: promotedPath,
        })
        console.log(`  promoted: ${promotedPath}`)
      } else {
        console.log('  verdict=promote — pass --auto-promote to actually move the file.')
      }
      return { verdict, comparison }
    }

    if (verdict === 'reject') {
      const today = new Date().toISOString().slice(0, 10)
      const rejectedPath = path.join(rejectedRoot, `${name}-${today}.md`)
      // Write the rejection capture BEFORE unlinking the candidate so a
      // failure here (disk full, permission) leaves the candidate intact
      // for a re-run rather than silently losing it.
      fs.writeFileSync(rejectedPath, table + `\n\n## Rationale (from candidate)\n\n${candidate.rationale ?? '(none)'}\n`)
      if (autoPromote) {
        // At this point rejectedPath definitely exists (synchronous write
        // above would have thrown otherwise).
        fs.unlinkSync(candidateFile)
      }
      appendExperimentLog({
        generation: 29,
        event: 'macro-rejected',
        name,
        rationale: candidate.rationale ?? '',
        verdict: comparison,
      })
      return { verdict, comparison }
    }

    return { verdict, comparison }
  } finally {
    activeStagingDirs.delete(stagingDir)
    fs.rmSync(stagingDir, { recursive: true, force: true })
  }
}
void interrupted // reserved for tests wanting to assert interrupted state

function validateCandidate(candidate, candidateFile) {
  if (!candidate || typeof candidate !== 'object') {
    throw new Error(`candidate JSON must be an object: ${candidateFile}`)
  }
  if (!candidate.macro || typeof candidate.macro !== 'object') {
    throw new Error('candidate.macro is required')
  }
  if (typeof candidate.macro.name !== 'string' || !candidate.macro.name) {
    throw new Error('candidate.macro.name required')
  }
  if (!SAFE_MACRO_NAME_REGEX.test(candidate.macro.name)) {
    throw new Error(`candidate.macro.name must match /^[a-z][a-z0-9-]*$/i, got ${JSON.stringify(candidate.macro.name)}`)
  }
  if (!candidate.eval || typeof candidate.eval !== 'object') {
    throw new Error('candidate.eval is required (bench case + reps + success criteria)')
  }
  if (typeof candidate.eval.benchCase !== 'string') {
    throw new Error('candidate.eval.benchCase required')
  }
}

async function runMultiRep({ label, cases, config, reps, modes, out, env }) {
  const args = [
    'scripts/run-multi-rep.mjs',
    '--cases', cases,
    '--reps', String(reps),
    '--modes', modes,
    '--label', label,
    '--out', out,
  ]
  if (config) args.push('--config', config)
  if (verbose) console.log(`  → ${args.join(' ')}`)

  const exitCode = await new Promise((resolve) => {
    const proc = spawn('node', args, {
      cwd: rootDir,
      env,
      stdio: verbose ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    })
    // Collect minimal output for failure diagnostics without flooding stdout
    let stderrTail = ''
    if (!verbose && proc.stderr) {
      proc.stderr.on('data', (chunk) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-2048)
      })
    }
    proc.on('exit', (code, signal) => {
      if ((code ?? 1) !== 0 && !verbose) process.stderr.write(stderrTail)
      resolve(code ?? (signal ? 128 : 1))
    })
    proc.on('error', (err) => {
      console.error(`  multi-rep spawn error: ${err.message}`)
      resolve(1)
    })
  })
  if (exitCode !== 0) {
    throw new Error(`multi-rep exit ${exitCode} (label=${label})`)
  }
  const summaryPath = path.join(out, 'multi-rep-summary.json')
  if (!fs.existsSync(summaryPath)) {
    throw new Error(`no multi-rep-summary.json at ${summaryPath}`)
  }
  return JSON.parse(fs.readFileSync(summaryPath, 'utf-8'))
}

function renderComparisonTable(name, comparison, verdict) {
  const lines = []
  lines.push(`# Macro promotion: ${name}`)
  lines.push('')
  lines.push(`Verdict: **${verdict}**`)
  lines.push('')
  if (!comparison.baseline || !comparison.treatment) {
    lines.push('(missing baseline or treatment — cannot compare)')
    return lines.join('\n')
  }
  const b = comparison.baseline
  const t = comparison.treatment
  lines.push('| metric | baseline (mean) | treatment (mean) | Δ | reps | treatment min/max |')
  lines.push('|---|---|---|---|---|---|')
  lines.push(row('passRate', b.passRate, t.passRate, comparison.deltas.passRate, t.reps, '—'))
  lines.push(row('turnsUsed', b.turnsUsed.mean, t.turnsUsed.mean, comparison.deltas.turnsMean, t.reps, `${t.turnsUsed.min}/${t.turnsUsed.max}`))
  lines.push(row('costUsd', b.costUsd.mean, t.costUsd.mean, comparison.deltas.costMean, t.reps, `$${t.costUsd.min.toFixed(4)}/${t.costUsd.max.toFixed(4)}`))
  lines.push(row('durationMs', b.durationMs.mean, t.durationMs.mean, comparison.deltas.durationMeanMs, t.reps, `${t.durationMs.min}/${t.durationMs.max}`))
  return lines.join('\n')
}

function row(label, baseline, treatment, delta, reps, minMax) {
  return `| ${label} | ${fmt(baseline)} | ${fmt(treatment)} | ${fmt(delta)} | ${reps} | ${minMax} |`
}

function fmt(v) {
  if (typeof v !== 'number' || Number.isNaN(v)) return '—'
  if (Number.isInteger(v)) return String(v)
  return v.toFixed(Math.abs(v) < 0.01 ? 5 : 2)
}

function appendExperimentLog(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'
  fs.appendFileSync(experimentsPath, line)
}
