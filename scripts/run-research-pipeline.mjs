#!/usr/bin/env node

/**
 * Research Pipeline — automated hypothesis testing with two-stage screening.
 *
 * Stage 1 (screen): 1 rep per hypothesis, cheap filter to identify candidates.
 * Stage 2 (validate): 5 reps for candidates only, statistical significance.
 *
 * Usage:
 *   # Two-stage (recommended) — screen all, validate winners
 *   pnpm research:pipeline --queue bench/research/speed-v1.json --two-stage
 *
 *   # Manual stages
 *   pnpm research:pipeline --queue ... --screen
 *   pnpm research:pipeline --queue ... --validate --screen-results ./agent-results/research-xxx
 *
 *   # Classic (flat reps, no staging)
 *   pnpm research:pipeline --queue bench/research/speed-v1.json
 *
 *   # Cost estimate before running
 *   pnpm research:pipeline --queue bench/research/speed-v1.json --estimate
 *
 *   # Parallel hypotheses
 *   pnpm research:pipeline --queue ... --hypothesis-concurrency 3
 *
 *   # Filter
 *   pnpm research:pipeline --queue ... --hypothesis llm-timeout-30s
 *   pnpm research:pipeline --queue ... --max-priority 2
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

// ── CLI parsing ──────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const getArg = (name, fallback = undefined) => {
  const idx = argv.indexOf(`--${name}`)
  if (idx === -1) return fallback
  if (idx === argv.length - 1) return 'true'
  return argv[idx + 1]
}
const hasFlag = (name) => argv.includes(`--${name}`)

const rootDir = path.resolve(path.join(new URL('.', import.meta.url).pathname, '..'))
const queuePath = path.resolve(getArg('queue', ''))
const filterHypothesis = getArg('hypothesis')
const maxPriority = Number.parseInt(getArg('max-priority', '99'), 10)
const dryRun = hasFlag('dry-run')
const estimate = hasFlag('estimate')
const skipCompleted = hasFlag('resume')
const outRoot = path.resolve(getArg('out', `./agent-results/research-${Date.now()}`))
const hypothesisConcurrency = Math.max(1, Number.parseInt(getArg('hypothesis-concurrency', '1'), 10))

// Stage mode
const twoStage = hasFlag('two-stage')
const screenOnly = hasFlag('screen')
const validateOnly = hasFlag('validate')
const screenResultsDir = getArg('screen-results')
const screenReps = Number.parseInt(getArg('screen-reps', '1'), 10)
const validateReps = Number.parseInt(getArg('validate-reps', '5'), 10)

if (!getArg('queue') || !fs.existsSync(queuePath) || fs.statSync(queuePath).isDirectory()) {
  printUsage()
  process.exit(1)
}

// ── Load queue ───────────────────────────────────────────────────────────────

const queue = JSON.parse(fs.readFileSync(queuePath, 'utf-8'))
const { defaults, control, hypotheses } = queue

if (!Array.isArray(hypotheses) || hypotheses.length === 0) {
  console.error('Queue must contain a non-empty "hypotheses" array.')
  process.exit(1)
}

// Load cases for cost estimation
const casesPath = defaults.casesPath ? path.resolve(defaults.casesPath) : null
const caseCount = casesPath && fs.existsSync(casesPath)
  ? JSON.parse(fs.readFileSync(casesPath, 'utf-8')).length
  : 4

// Filter and sort hypotheses
let selected = hypotheses
  .filter((h) => !filterHypothesis || h.id === filterHypothesis)
  .filter((h) => (h.priority ?? 99) <= maxPriority)
  .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))

if (selected.length === 0) {
  console.error(`No hypotheses matched filters (--hypothesis=${filterHypothesis ?? 'all'}, --max-priority=${maxPriority}).`)
  process.exit(1)
}

// ── Cost estimation ──────────────────────────────────────────────────────────

const AVG_COST_PER_CASE = 0.25 // $0.25 per case run (fast-explore, gpt-5.4)

function estimateCost(hypothesisCount, repsPerHypothesis, cases) {
  // 2 arms × reps × cases
  return hypothesisCount * 2 * repsPerHypothesis * cases * AVG_COST_PER_CASE
}

if (estimate || dryRun) {
  const reps = defaults.repetitions ?? 3
  console.log(`[pipeline] ${queue.name}`)
  console.log(`[pipeline] ${selected.length} hypotheses × ${caseCount} cases × 2 arms`)
  console.log('')

  if (twoStage) {
    const screenCost = estimateCost(selected.length, screenReps, caseCount)
    // Assume ~30% pass screening (optimistic)
    const candidateCount = Math.max(1, Math.ceil(selected.length * 0.3))
    const validateCost = estimateCost(candidateCount, validateReps, caseCount)
    console.log(`  Stage 1 (screen):   ${selected.length} hypotheses × ${screenReps} rep  = ~$${screenCost.toFixed(2)}`)
    console.log(`  Stage 2 (validate): ~${candidateCount} candidates × ${validateReps} reps = ~$${validateCost.toFixed(2)}`)
    console.log(`  Total estimate: ~$${(screenCost + validateCost).toFixed(2)}`)
    console.log(`  (vs flat ${reps} reps: ~$${estimateCost(selected.length, reps, caseCount).toFixed(2)})`)
  } else {
    const flatCost = estimateCost(selected.length, reps, caseCount)
    console.log(`  ${selected.length} hypotheses × ${reps} reps = ~$${flatCost.toFixed(2)}`)
  }
  console.log('')

  for (const h of selected) {
    console.log(`  ${h.id} (priority ${h.priority ?? '—'})`)
    console.log(`    ${h.name}`)
    console.log(`    treatment: ${JSON.stringify(h.treatment)}`)
    console.log('')
  }

  if (estimate) {
    console.log('[pipeline] estimate complete (use --dry-run to also preview, or remove --estimate to run)')
    process.exit(0)
  }
  console.log('[pipeline] dry run complete')
  process.exit(0)
}

// ── Execution ────────────────────────────────────────────────────────────────

fs.mkdirSync(outRoot, { recursive: true })

if (skipCompleted) {
  selected = selected.filter((h) => {
    const summaryPath = path.join(outRoot, h.id, 'summary.json')
    if (fs.existsSync(summaryPath)) {
      console.log(`[pipeline] skip ${h.id} (already has results)`)
      return false
    }
    return true
  })
}

if (twoStage) {
  await runTwoStage(selected)
} else if (screenOnly) {
  await runStage(selected, screenReps, 'screen')
} else if (validateOnly) {
  const candidates = loadScreenCandidates(screenResultsDir, selected)
  if (candidates.length === 0) {
    console.log('[pipeline] no candidates from screening — nothing to validate')
    process.exit(0)
  }
  await runStage(candidates, validateReps, 'validate')
} else {
  await runStage(selected, defaults.repetitions ?? 3, 'flat')
}

// ── Two-stage runner ─────────────────────────────────────────────────────────

async function runTwoStage(hypotheses) {
  console.log(`[pipeline] ${queue.name} — TWO-STAGE`)
  console.log(`[pipeline] stage 1: screen ${hypotheses.length} hypotheses (${screenReps} rep)`)
  const screenCost = estimateCost(hypotheses.length, screenReps, caseCount)
  console.log(`[pipeline] estimated cost: ~$${screenCost.toFixed(2)}`)
  console.log('')

  // Stage 1: screen
  const screenDir = path.join(outRoot, '_screen')
  const screenResults = await runHypotheses(hypotheses, screenReps, screenDir)
  writeStageReport(screenDir, screenResults, 'Screen')

  // Identify candidates: not rejected, and (positive delta OR efficiency gain)
  const candidates = screenResults.filter((r) =>
    r.decision === 'promote' || r.decision === 'candidate' ||
    (r.decision === 'inconclusive' && isEfficiencyWin(r))
  )
  const rejected = screenResults.filter((r) => r.decision === 'reject')

  console.log(`\n[pipeline] ── screen complete ──────────────────`)
  console.log(`[pipeline] candidates: ${candidates.length} | rejected: ${rejected.length} | inconclusive: ${screenResults.length - candidates.length - rejected.length}`)

  if (candidates.length === 0) {
    console.log('[pipeline] no candidates passed screening')
    writeFinalReport(outRoot, screenResults, [], 'two-stage')
    return
  }

  // Stage 2: validate candidates with more reps
  console.log(`\n[pipeline] stage 2: validate ${candidates.length} candidates (${validateReps} reps)`)
  const validateCost = estimateCost(candidates.length, validateReps, caseCount)
  console.log(`[pipeline] estimated cost: ~$${validateCost.toFixed(2)}`)

  const candidateHypotheses = candidates.map((r) => hypotheses.find((h) => h.id === r.id)).filter(Boolean)
  const validateDir = path.join(outRoot, '_validate')
  const validateResults = await runHypotheses(candidateHypotheses, validateReps, validateDir)
  writeStageReport(validateDir, validateResults, 'Validate')

  writeFinalReport(outRoot, screenResults, validateResults, 'two-stage')
}

// ── Single-stage runner ──────────────────────────────────────────────────────

async function runStage(hypotheses, reps, label) {
  console.log(`[pipeline] ${queue.name} — ${label.toUpperCase()}`)
  console.log(`[pipeline] ${hypotheses.length} hypotheses × ${reps} reps`)
  const cost = estimateCost(hypotheses.length, reps, caseCount)
  console.log(`[pipeline] estimated cost: ~$${cost.toFixed(2)}`)
  console.log('')

  const results = await runHypotheses(hypotheses, reps, outRoot)
  writeFinalReport(outRoot, results, [], label)
}

// ── Hypothesis execution (parallel-capable) ──────────────────────────────────

async function runHypotheses(hypotheses, reps, stageDir) {
  fs.mkdirSync(stageDir, { recursive: true })
  const results = await runPool(hypotheses, hypothesisConcurrency, async (h, i) => {
    const slug = `${String(i + 1).padStart(2, '0')}-${h.id}`
    const hypDir = path.join(stageDir, h.id)
    fs.mkdirSync(hypDir, { recursive: true })

    console.log(`\n[pipeline] ── ${slug} ──────────────────────────`)
    console.log(`[pipeline] ${h.name}`)
    if (hypothesisConcurrency === 1) {
      console.log(`[pipeline] rationale: ${h.rationale}`)
    }

    // Generate arm configs
    const controlConfig = buildArmConfig(defaults, control)
    const treatmentConfig = buildArmConfig(defaults, h.treatment)

    const controlPath = path.join(hypDir, 'control.mjs')
    const treatmentPath = path.join(hypDir, 'treatment.mjs')
    fs.writeFileSync(controlPath, configToModule(controlConfig))
    fs.writeFileSync(treatmentPath, configToModule(treatmentConfig))

    // Generate experiment spec
    const spec = {
      casesPath: defaults.casesPath,
      model: defaults.model,
      repetitions: reps,
      concurrency: defaults.concurrency ?? 1,
      scenarioConcurrency: defaults.scenarioConcurrency ?? 2,
      seed: defaults.seed ?? '2026',
      benchmarkProfile: defaults.benchmarkProfile ?? 'webbench-stealth',
      memoryIsolation: defaults.memoryIsolation ?? 'per-run',
      modes: defaults.modes ?? 'fast-explore',
      arms: [
        { id: 'off', configPath: controlPath },
        { id: 'on', configPath: treatmentPath },
      ],
    }

    const specPath = path.join(hypDir, 'spec.json')
    fs.writeFileSync(specPath, JSON.stringify(spec, null, 2) + '\n')

    // Run experiment
    const exitCode = await spawnAndWait('node', [
      'scripts/run-ab-experiment.mjs',
      '--spec', specPath,
      '--out', hypDir,
    ], {
      cwd: rootDir,
      env: process.env,
      stdio: hypothesisConcurrency > 1 ? 'pipe' : 'inherit',
    })

    // Collect results
    const summaryPath = path.join(hypDir, 'summary.json')
    const summary = fs.existsSync(summaryPath)
      ? JSON.parse(fs.readFileSync(summaryPath, 'utf-8'))
      : null

    const result = extractResult(h, summary, exitCode, hypDir)

    console.log(`[pipeline] ${h.id}: ${result.decision} (clean Δ=${fmtPct(result.deltaClean)}, ci=${fmtCi(result.deltaCleanCi)})`)
    if (result.turnsDelta !== null) {
      console.log(`[pipeline]   turns: ${fmtDelta(result.turnsDelta)} | tokens: ${fmtDelta(result.tokensDelta)} | cost: $${fmtDelta(result.costDelta)}`)
    }

    return result
  })

  return results
}

// ── Screen candidate loading ─────────────────────────────────────────────────

function loadScreenCandidates(screenDir, allHypotheses) {
  if (!screenDir) {
    console.error('--validate requires --screen-results <dir>')
    process.exit(1)
  }
  const summaryPath = path.join(path.resolve(screenDir), 'stage-summary.json')
  if (!fs.existsSync(summaryPath)) {
    console.error(`Screen results not found: ${summaryPath}`)
    process.exit(1)
  }
  const screenSummary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'))
  const candidateIds = new Set(
    screenSummary.leaderboard
      .filter((r) => r.decision !== 'reject' && r.decision !== 'error')
      .map((r) => r.id)
  )
  return allHypotheses.filter((h) => candidateIds.has(h.id))
}

// ── Result extraction ────────────────────────────────────────────────────────

function extractResult(hypothesis, summary, exitCode, hypDir) {
  if (!summary || !summary.delta) {
    return {
      id: hypothesis.id,
      name: hypothesis.name,
      priority: hypothesis.priority ?? null,
      rank: 0,
      decision: 'error',
      exitCode,
      hypDir,
      deltaClean: null,
      deltaCleanCi: null,
      deltaRaw: null,
      deltaRawCi: null,
      score: -Infinity,
      turnsDelta: null,
      tokensDelta: null,
      costDelta: null,
      controlCost: null,
      treatmentCost: null,
    }
  }

  const deltaClean = summary?.delta?.clean?.onMinusOff ?? null
  const deltaCleanCi = summary?.delta?.clean?.bootstrap95 ?? null
  const deltaRaw = summary?.delta?.raw?.onMinusOff ?? null
  const deltaRawCi = summary?.delta?.raw?.bootstrap95 ?? null
  const score = Array.isArray(deltaCleanCi) ? Number(deltaCleanCi[0]) : Number(deltaClean ?? -Infinity)

  const controlArm = summary?.byArm?.off
  const treatmentArm = summary?.byArm?.on
  const turnsDelta = safeSubtract(treatmentArm?.avgTurns, controlArm?.avgTurns)
  const tokensDelta = safeSubtract(treatmentArm?.avgTokens, controlArm?.avgTokens)
  const costDelta = safeSubtract(treatmentArm?.avgCost, controlArm?.avgCost)

  const decision = classifyDecision(deltaCleanCi, deltaClean, turnsDelta, tokensDelta)

  return {
    id: hypothesis.id,
    name: hypothesis.name,
    priority: hypothesis.priority ?? null,
    rank: 0,
    decision,
    exitCode,
    hypDir,
    deltaClean,
    deltaCleanCi,
    deltaRaw,
    deltaRawCi,
    score,
    turnsDelta,
    tokensDelta,
    costDelta,
    controlCost: controlArm?.avgCost ?? null,
    treatmentCost: treatmentArm?.avgCost ?? null,
  }
}

function classifyDecision(deltaCi, deltaMean, turnsDelta, tokensDelta) {
  if (Array.isArray(deltaCi) && deltaCi.length === 2) {
    if (Number(deltaCi[0]) > 0) return 'promote'
    if (Number(deltaCi[1]) < 0) return 'reject'
    // CI spans zero — promote on efficiency gains if no regression risk
    if (Number(deltaCi[0]) >= -0.02) {
      if (turnsDelta !== null && turnsDelta < -0.5) return 'promote'
      if (tokensDelta !== null && tokensDelta < -500) return 'promote'
    }
    return 'inconclusive'
  }
  if (Number.isFinite(deltaMean) && Number(deltaMean) > 0) return 'candidate'
  return 'inconclusive'
}

function isEfficiencyWin(result) {
  return (result.turnsDelta !== null && result.turnsDelta < -0.3) ||
    (result.tokensDelta !== null && result.tokensDelta < -300)
}

// ── Reporting ────────────────────────────────────────────────────────────────

function writeStageReport(stageDir, results, label) {
  const ranked = rankResults(results)
  const summary = {
    generatedAt: new Date().toISOString(),
    stage: label.toLowerCase(),
    totalHypotheses: results.length,
    promoted: ranked.filter((r) => r.decision === 'promote').length,
    rejected: ranked.filter((r) => r.decision === 'reject').length,
    inconclusive: ranked.filter((r) => r.decision === 'inconclusive').length,
    leaderboard: ranked,
  }
  fs.writeFileSync(path.join(stageDir, 'stage-summary.json'), JSON.stringify(summary, null, 2) + '\n')
}

function writeFinalReport(outDir, screenOrFlatResults, validateResults, mode) {
  const finalResults = validateResults.length > 0 ? validateResults : screenOrFlatResults
  const ranked = rankResults(finalResults)

  const pipelineSummary = {
    generatedAt: new Date().toISOString(),
    mode,
    queueName: queue.name,
    queuePath,
    outRoot: outDir,
    totalHypotheses: screenOrFlatResults.length,
    validated: validateResults.length,
    promoted: ranked.filter((r) => r.decision === 'promote').length,
    rejected: ranked.filter((r) => r.decision === 'reject').length,
    inconclusive: ranked.filter((r) => r.decision === 'inconclusive').length,
    leaderboard: ranked,
    screenResults: mode === 'two-stage' ? rankResults(screenOrFlatResults) : undefined,
  }

  fs.writeFileSync(path.join(outDir, 'pipeline-summary.json'), JSON.stringify(pipelineSummary, null, 2) + '\n')
  writeCsv(path.join(outDir, 'pipeline-leaderboard.csv'), ranked)
  writeMarkdownReport(path.join(outDir, 'pipeline-report.md'), pipelineSummary, queue, mode)

  console.log('\n[pipeline] ══════════════════════════════════════')
  console.log(`[pipeline] complete — ${pipelineSummary.totalHypotheses} hypotheses tested`)
  if (mode === 'two-stage') {
    console.log(`[pipeline] screened: ${screenOrFlatResults.length} → validated: ${validateResults.length}`)
  }
  console.log(`[pipeline] promoted: ${pipelineSummary.promoted} | rejected: ${pipelineSummary.rejected} | inconclusive: ${pipelineSummary.inconclusive}`)
  console.log(`[pipeline] report: ${path.join(outDir, 'pipeline-report.md')}`)
  if (ranked.length > 0) {
    const top = ranked[0]
    console.log(`[pipeline] top: ${top.id} (${top.decision}) clean Δ=${fmtPct(top.deltaClean)} ci=${fmtCi(top.deltaCleanCi)}`)
  }
}

function writeMarkdownReport(filePath, summary, queue, mode) {
  const lines = []
  lines.push(`# Research Pipeline: ${queue.name}`)
  lines.push('')
  lines.push(`- Generated: ${summary.generatedAt}`)
  lines.push(`- Mode: ${mode}`)
  lines.push(`- Queue: \`${path.basename(summary.queuePath)}\``)
  lines.push(`- Model: ${queue.defaults?.model ?? 'default'}`)
  lines.push(`- Cases: \`${queue.defaults?.casesPath ?? 'default'}\` (${caseCount} cases)`)
  if (mode === 'two-stage') {
    lines.push(`- Screen: ${summary.totalHypotheses} hypotheses × ${screenReps} rep → ${summary.validated} candidates × ${validateReps} reps`)
  } else {
    lines.push(`- Hypotheses: ${summary.totalHypotheses} × ${queue.defaults?.repetitions ?? 3} reps`)
  }
  lines.push(`- Result: ${summary.promoted} promoted | ${summary.rejected} rejected | ${summary.inconclusive} inconclusive`)
  lines.push('')

  // Promotion recommendations
  const promoted = summary.leaderboard.filter((r) => r.decision === 'promote')
  if (promoted.length > 0) {
    lines.push('## Promote')
    lines.push('')
    for (const r of promoted) {
      const h = queue.hypotheses.find((x) => x.id === r.id)
      lines.push(`### ${r.id}`)
      lines.push(`- **${r.name}**`)
      lines.push(`- Rationale: ${h?.rationale ?? '—'}`)
      lines.push(`- Clean delta: ${fmtPct(r.deltaClean)} (CI: ${fmtCi(r.deltaCleanCi)})`)
      if (r.turnsDelta !== null) lines.push(`- Turns: ${fmtDelta(r.turnsDelta)}`)
      if (r.tokensDelta !== null) lines.push(`- Tokens: ${fmtDelta(r.tokensDelta)}`)
      if (r.costDelta !== null) lines.push(`- Cost/case: $${fmtDelta(r.costDelta)}`)
      lines.push(`- Config: \`${JSON.stringify(h?.treatment ?? {})}\``)
      lines.push('')
    }
  }

  // Leaderboard
  lines.push('## Leaderboard')
  lines.push('')
  lines.push('| # | Hypothesis | Decision | Clean Δ | CI | Turns Δ | Tokens Δ |')
  lines.push('|--:|-----------|----------|--------:|:---|--------:|---------:|')
  for (const r of summary.leaderboard) {
    lines.push(
      `| ${r.rank} | ${r.id} | ${r.decision} | ${fmtPct(r.deltaClean)} | ${fmtCi(r.deltaCleanCi)} | ${fmtDelta(r.turnsDelta)} | ${fmtDelta(r.tokensDelta)} |`,
    )
  }
  lines.push('')

  // Screen results (two-stage only)
  if (summary.screenResults) {
    lines.push('## Screen Results')
    lines.push('')
    lines.push('| Hypothesis | Decision | Clean Δ | Turns Δ | Tokens Δ |')
    lines.push('|-----------|----------|--------:|--------:|---------:|')
    for (const r of summary.screenResults) {
      lines.push(`| ${r.id} | ${r.decision} | ${fmtPct(r.deltaClean)} | ${fmtDelta(r.turnsDelta)} | ${fmtDelta(r.tokensDelta)} |`)
    }
    lines.push('')
  }

  // Rejected
  const rejected = summary.leaderboard.filter((r) => r.decision === 'reject')
  if (rejected.length > 0) {
    lines.push('## Rejected')
    lines.push('')
    for (const r of rejected) {
      lines.push(`- **${r.id}**: ${r.name} — clean Δ ${fmtPct(r.deltaClean)} (CI: ${fmtCi(r.deltaCleanCi)})`)
    }
    lines.push('')
  }

  fs.writeFileSync(filePath, lines.join('\n') + '\n')
}

// ── Utilities ────────────────────────────────────────────────────────────────

function rankResults(results) {
  const decisionOrder = { promote: 0, candidate: 1, inconclusive: 2, reject: 3, error: 4 }
  const ranked = [...results].sort((a, b) => {
    const decDiff = (decisionOrder[a.decision] ?? 4) - (decisionOrder[b.decision] ?? 4)
    if (decDiff !== 0) return decDiff
    return (b.score ?? -Infinity) - (a.score ?? -Infinity)
  })
  ranked.forEach((r, i) => { r.rank = i + 1 })
  return ranked
}

function buildArmConfig(defaults, overrides) {
  const config = {}
  if (defaults.model) config.model = defaults.model
  if (defaults.provider) config.provider = defaults.provider
  return deepMerge(config, overrides ?? {})
}

function deepMerge(target, source) {
  const out = { ...target }
  for (const [key, val] of Object.entries(source)) {
    if (val && typeof val === 'object' && !Array.isArray(val) && target[key] && typeof target[key] === 'object') {
      out[key] = deepMerge(target[key], val)
    } else {
      out[key] = val
    }
  }
  return out
}

function configToModule(config) {
  return `export default ${JSON.stringify(config, null, 2)};\n`
}

function safeSubtract(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return a - b
}

function fmtPct(value) {
  if (!Number.isFinite(Number(value))) return 'n/a'
  return `${(Number(value) * 100).toFixed(2)}pp`
}

function fmtCi(ci) {
  if (!Array.isArray(ci) || ci.length !== 2) return 'n/a'
  return `${fmtPct(ci[0])} to ${fmtPct(ci[1])}`
}

function fmtDelta(value) {
  if (!Number.isFinite(value)) return 'n/a'
  const sign = value >= 0 ? '+' : ''
  return `${sign}${value.toFixed(1)}`
}

function writeCsv(filePath, rows) {
  const header = [
    'rank', 'id', 'name', 'priority', 'decision', 'score',
    'deltaClean', 'deltaCleanCiLo', 'deltaCleanCiHi',
    'turnsDelta', 'tokensDelta', 'costDelta',
    'exitCode', 'hypDir',
  ]
  const lines = [header.join(',')]
  for (const row of rows) {
    lines.push([
      row.rank,
      csvEscape(row.id),
      csvEscape(row.name),
      row.priority ?? '',
      row.decision,
      row.score === -Infinity ? '' : row.score,
      row.deltaClean ?? '',
      Array.isArray(row.deltaCleanCi) ? row.deltaCleanCi[0] : '',
      Array.isArray(row.deltaCleanCi) ? row.deltaCleanCi[1] : '',
      row.turnsDelta ?? '',
      row.tokensDelta ?? '',
      row.costDelta ?? '',
      row.exitCode,
      csvEscape(row.hypDir),
    ].join(','))
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n')
}

function csvEscape(value) {
  const s = String(value ?? '')
  if (!/[",\n]/.test(s)) return s
  return `"${s.replace(/"/g, '""')}"`
}

async function runPool(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0

  async function runner() {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  }

  const workerCount = Math.min(limit, Math.max(1, items.length))
  await Promise.all(Array.from({ length: workerCount }, () => runner()))
  return results
}

function spawnAndWait(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options)
    child.once('error', () => resolve(1))
    child.once('close', (code) => resolve(code ?? 1))
  })
}

function printUsage() {
  console.error('Usage: node scripts/run-research-pipeline.mjs --queue <path>')
  console.error('')
  console.error('Modes:')
  console.error('  (default)                    Flat run: N reps per hypothesis')
  console.error('  --two-stage                  Screen (1 rep) → validate (5 reps) for candidates')
  console.error('  --screen                     Screen only (1 rep per hypothesis)')
  console.error('  --validate                   Validate only (requires --screen-results)')
  console.error('')
  console.error('Options:')
  console.error('  --queue <path>               Hypothesis queue JSON (required)')
  console.error('  --hypothesis <id>            Run only this hypothesis')
  console.error('  --max-priority <n>           Only run hypotheses with priority <= n (default: 99)')
  console.error('  --hypothesis-concurrency <n> Run N hypotheses in parallel (default: 1)')
  console.error('  --out <dir>                  Output directory')
  console.error('  --estimate                   Show cost estimate and exit')
  console.error('  --dry-run                    Preview without executing')
  console.error('  --resume                     Skip hypotheses with existing results')
  console.error('  --screen-results <dir>       Path to screening results (for --validate)')
  console.error('  --screen-reps <n>            Reps per hypothesis in screen stage (default: 1)')
  console.error('  --validate-reps <n>          Reps per hypothesis in validate stage (default: 5)')
}
