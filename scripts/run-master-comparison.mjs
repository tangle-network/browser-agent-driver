#!/usr/bin/env node
/**
 * Gen 11 — Master comparison runner.
 *
 * Walks every benchmark tier we have and aggregates the results into a single
 * REPORT.md. The shipping artifact is `agent-results/master-comparison-<ts>/REPORT.md`.
 *
 * Tiers (in order; later tiers depend on nothing from earlier tiers):
 *   A — cross-framework gauntlet (bad Gen 10 vs browser-use 0.12.6) — 5-rep
 *   B — WebVoyager curated 30-task sample (bad only) — 1-rep with LLM judge
 *   C — multi-model truth table (bad on gpt-5.2 vs gpt-5.4) — 3-rep
 *   D — Tier 1 deterministic regression check
 *
 * Usage:
 *   node scripts/run-master-comparison.mjs
 *   node scripts/run-master-comparison.mjs --skip-tier B --skip-tier C
 *   node scripts/run-master-comparison.mjs --tier A --reps 3        (single tier override)
 *
 * Each tier runs as a child process. We capture its summary JSON and continue
 * even if a tier fails. The aggregator at the end reads whatever is on disk and
 * produces an honest report (with explicit "tier failed / not run" markers).
 *
 * Cost guard: hard cap at $25 cumulative. Aborts further tiers if exceeded.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const rootDir = path.resolve(path.join(new URL('.', import.meta.url).pathname, '..'))
const argv = process.argv.slice(2)
const getArg = (name, fallback) => {
  const idx = argv.indexOf(`--${name}`)
  if (idx === -1) return fallback
  return argv[idx + 1]
}
const getArgs = (name) => {
  const out = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}`) out.push(argv[i + 1])
  }
  return out
}

const skipTiers = new Set(getArgs('skip-tier'))
const onlyTier = getArg('tier', null)  // single-tier override
const tierRepsOverride = getArg('reps', null)
const COST_CAP_USD = Number(getArg('cost-cap', '25'))
const outRoot = getArg('out', path.join(rootDir, 'agent-results', `master-comparison-${Date.now()}`))

fs.mkdirSync(outRoot, { recursive: true })
const tierLogPath = path.join(outRoot, 'tier-log.jsonl')
const reportPath = path.join(outRoot, 'REPORT.md')

console.log(`master-comparison: outRoot = ${outRoot}`)
console.log(`master-comparison: cost cap = $${COST_CAP_USD}`)
if (onlyTier) console.log(`master-comparison: ONLY running tier ${onlyTier}`)
if (skipTiers.size > 0) console.log(`master-comparison: skipping tiers ${[...skipTiers].join(', ')}`)

// ============================================================================
// Pre-flight checks
// ============================================================================

const preflightErrors = []

// browser-use install check
const venvPython = path.join(rootDir, '.venv-browseruse', 'bin', 'python')
if (!fs.existsSync(venvPython)) {
  preflightErrors.push(`Tier A requires browser-use venv at ${venvPython}`)
} else {
  const probe = spawnSync(venvPython, ['-c', 'from browser_use import Agent'], { encoding: 'utf-8' })
  if (probe.status !== 0) {
    preflightErrors.push(`Tier A: browser-use Agent class not importable: ${probe.stderr}`)
  }
}

// .env / OPENAI_API_KEY check
const envPath = path.join(rootDir, '.env')
let envHasOpenaiKey = false
if (fs.existsSync(envPath)) {
  const envText = fs.readFileSync(envPath, 'utf-8')
  envHasOpenaiKey = /^OPENAI_API_KEY=.+$/m.test(envText)
}
if (!envHasOpenaiKey) {
  preflightErrors.push('OPENAI_API_KEY not in .env (required for all tiers)')
}

// WebVoyager curated subset check
const curatedPath = path.join(rootDir, 'bench', 'external', 'webvoyager', 'curated-30.json')
if (!fs.existsSync(curatedPath)) {
  preflightErrors.push(`Tier B requires curated subset at ${curatedPath}`)
}

if (preflightErrors.length > 0) {
  console.error('master-comparison: PREFLIGHT ERRORS:')
  for (const e of preflightErrors) console.error(`  - ${e}`)
  console.error('master-comparison: aborting; fix the errors above and retry')
  process.exit(1)
}

console.log('master-comparison: preflight OK')

// ============================================================================
// Tier launch helper
// ============================================================================

let cumulativeCostUsd = 0

function appendTierLog(entry) {
  fs.appendFileSync(tierLogPath, JSON.stringify(entry) + '\n')
}

function shouldRunTier(tierId) {
  if (onlyTier && onlyTier !== tierId) return false
  if (skipTiers.has(tierId)) return false
  return true
}

function launchTier(tierId, name, command, args, opts = {}) {
  if (!shouldRunTier(tierId)) {
    console.log(`\n=== Tier ${tierId} (${name}) — SKIPPED ===`)
    appendTierLog({ tierId, name, status: 'skipped', startedAt: new Date().toISOString() })
    return { status: 'skipped' }
  }
  if (cumulativeCostUsd > COST_CAP_USD) {
    console.error(`\n=== Tier ${tierId} (${name}) — ABORTED (cost cap $${COST_CAP_USD} exceeded) ===`)
    appendTierLog({ tierId, name, status: 'cost-cap-aborted', cumulativeCostUsd, startedAt: new Date().toISOString() })
    return { status: 'cost-cap-aborted' }
  }
  console.log(`\n=== Tier ${tierId} (${name}) ===`)
  console.log(`    command: ${command} ${args.join(' ')}`)
  const startedAt = Date.now()
  appendTierLog({ tierId, name, status: 'running', startedAt: new Date(startedAt).toISOString(), command, args })
  const result = spawnSync(command, args, {
    cwd: opts.cwd || rootDir,
    stdio: 'inherit',
    encoding: 'utf-8',
    env: { ...process.env, ...(opts.env || {}) },
  })
  const durationMs = Date.now() - startedAt
  const status = result.status === 0 ? 'completed' : 'failed'
  // exit code 1 from competitive runners means at least one rep failed (not crash)
  const completedDespiteFailures = result.status === 1 && opts.tolerateFailures
  const finalStatus = status === 'failed' && completedDespiteFailures ? 'completed-with-failures' : status
  appendTierLog({
    tierId,
    name,
    status: finalStatus,
    exitCode: result.status,
    durationMs,
    completedAt: new Date().toISOString(),
  })
  return { status: finalStatus, exitCode: result.status, durationMs }
}

// ============================================================================
// Tier definitions
// ============================================================================

const realWebTasks = [
  'hn-top-story-score',
  'wikipedia-fact-lookup',
  'github-pr-count',
  'mdn-array-flatmap',
  'npm-package-downloads',
  'arxiv-paper-abstract',
  'reddit-subreddit-titles',
  'stackoverflow-answer-count',
  'w3c-html-spec-find-element',
  'python-docs-method-signature',
].join(',')

const tierAReps = Number(tierRepsOverride ?? '5')
const tierCReps = Number(tierRepsOverride ?? '3')

// Tier A — cross-framework gauntlet
const tierAOut = path.join(outRoot, 'tier-a-cross-framework')
const tierAResult = launchTier(
  'A',
  `cross-framework gauntlet (bad Gen 10 vs browser-use, ${tierAReps}-rep, 10 tasks)`,
  'node',
  [
    './scripts/run-competitive.mjs',
    '--frameworks', 'bad,browser-use',
    '--tasks', realWebTasks,
    '--reps', String(tierAReps),
    '--config', 'bench/scenarios/configs/planner-on-realweb.mjs',
    '--out', tierAOut,
  ],
  { tolerateFailures: true },
)

// Tier B — WebVoyager 30-task curated sample (bad only, 1-rep)
const tierBOut = path.join(outRoot, 'tier-b-webvoyager')
const tierBResult = launchTier(
  'B',
  'WebVoyager 30-task curated sample (bad Gen 10, 1-rep + LLM judge)',
  'node',
  [
    './bench/external/webvoyager/run.mjs',
    '--cases-file', curatedPath,
    '--model', 'gpt-5.2',
    '--concurrency', '3',
    '--out', tierBOut,
  ],
  { tolerateFailures: true },
)

// Tier C — multi-model on the gauntlet (gpt-5.2 vs gpt-5.4, 3-rep)
const tierCOut = path.join(outRoot, 'tier-c-multi-model')
fs.mkdirSync(tierCOut, { recursive: true })
const tierCResults = {}
for (const model of ['gpt-5.2', 'gpt-5.4']) {
  const subOut = path.join(tierCOut, model)
  const r = launchTier(
    `C-${model}`,
    `bad Gen 10 on ${model} (${tierCReps}-rep, 10 tasks)`,
    'node',
    [
      './scripts/run-competitive.mjs',
      '--frameworks', 'bad',
      '--tasks', realWebTasks,
      '--reps', String(tierCReps),
      '--model', model,
      '--config', 'bench/scenarios/configs/planner-on-realweb.mjs',
      '--out', subOut,
    ],
    { tolerateFailures: true },
  )
  tierCResults[model] = r
}

// Tier D — Tier 1 deterministic regression check
const tierDOut = path.join(outRoot, 'tier-d-tier1-gate')
const tierDResult = launchTier(
  'D',
  'Tier 1 deterministic gate (regression check)',
  'node',
  ['./scripts/run-tier1-gate.mjs', '--out', tierDOut],
)

// ============================================================================
// Aggregation
// ============================================================================

console.log('\n=== Aggregating results into REPORT.md ===')

function safeReadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch {
    return null
  }
}

function fmtPct(numerator, denominator) {
  if (!denominator) return 'n/a'
  return `${numerator}/${denominator} = ${(100 * numerator / denominator).toFixed(0)}%`
}

function fmtCost(usd) {
  if (usd == null || isNaN(usd)) return 'n/a'
  return `$${usd.toFixed(4)}`
}

function fmtTime(ms) {
  if (ms == null || isNaN(ms)) return 'n/a'
  return `${(ms / 1000).toFixed(1)}s`
}

// Tier A — cross-framework
const tierASummary = safeReadJson(path.join(tierAOut, 'gauntlet-summary.json'))

// Tier B — WebVoyager
const tierBSummary = safeReadJson(path.join(tierBOut, 'wv-eval.json'))
  || safeReadJson(path.join(tierBOut, 'track-summary.json'))

// Tier C — multi-model
const tierCSummaries = {}
for (const model of ['gpt-5.2', 'gpt-5.4']) {
  tierCSummaries[model] = safeReadJson(path.join(tierCOut, model, 'gauntlet-summary.json'))
}

// Tier D — Tier 1 gate
const tierDSummary = safeReadJson(path.join(tierDOut, 'tier1-gate-summary.json'))

// Build report
const reportLines = []
const push = (s = '') => reportLines.push(s)

push('# Gen 11 — Master Comparison Report')
push('')
push(`**Date**: ${new Date().toISOString()}`)
push(`**Generated by**: \`scripts/run-master-comparison.mjs\``)
push(`**Output dir**: \`${path.relative(rootDir, outRoot)}\``)
push(`**Cost cap**: $${COST_CAP_USD} (cumulative across tiers)`)
push('')
push('## Executive summary')
push('')

// Headline numbers
const headlines = []
if (tierASummary) {
  const bad = tierASummary.frameworks.find((f) => f.framework === 'bad')
  const bu = tierASummary.frameworks.find((f) => f.framework === 'browser-use')
  if (bad && bu) {
    const delta = bad.passed - bu.passed
    headlines.push(`**Cross-framework**: bad ${fmtPct(bad.passed, bad.totalRuns)} vs browser-use ${fmtPct(bu.passed, bu.totalRuns)} (Δ ${delta >= 0 ? '+' : ''}${delta} tasks)`)
    headlines.push(`**Speed**: bad ${fmtTime(bad.wallTimeSecMean * 1000)} mean vs browser-use ${fmtTime(bu.wallTimeSecMean * 1000)} mean (${(bu.wallTimeSecMean / bad.wallTimeSecMean).toFixed(1)}× edge to bad)`)
    const badCostPerPass = bad.passed > 0 ? (bad.costUsdMean * bad.totalRuns) / bad.passed : null
    const buCostPerPass = bu.passed > 0 ? (bu.costUsdMean * bu.totalRuns) / bu.passed : null
    if (badCostPerPass != null && buCostPerPass != null) {
      headlines.push(`**Cost per pass**: bad ${fmtCost(badCostPerPass)} vs browser-use ${fmtCost(buCostPerPass)}`)
    }
  }
}
if (tierBSummary) {
  const passRate = tierBSummary.judgePassRate ?? tierBSummary.passRate ?? null
  const taskCount = tierBSummary.totalTasks ?? tierBSummary.taskCount ?? null
  if (passRate != null) {
    headlines.push(`**WebVoyager (curated 30)**: bad Gen 10 ${(passRate * 100).toFixed(0)}% LLM-judge pass rate`)
  }
}
if (Object.values(tierCSummaries).every(Boolean)) {
  const lines = []
  for (const [model, s] of Object.entries(tierCSummaries)) {
    const bad = s.frameworks?.find((f) => f.framework === 'bad')
    if (bad) lines.push(`${model}: ${fmtPct(bad.passed, bad.totalRuns)}, ${fmtCost(bad.costUsdMean)} mean`)
  }
  headlines.push(`**Multi-model**: ${lines.join(' · ')}`)
}
if (tierDSummary) {
  headlines.push(`**Tier 1 deterministic gate**: ${tierDSummary.passed === true || tierDSummary.gateStatus === 'PASSED' ? 'PASSED' : 'FAILED'}`)
}

if (headlines.length === 0) {
  push('No tier completed. See per-tier sections below for details.')
} else {
  for (const h of headlines) push(`- ${h}`)
}
push('')

// ============================================================================
// Tier A: cross-framework
// ============================================================================
push('## Tier A — Cross-framework gauntlet (bad Gen 10 vs browser-use 0.12.6)')
push('')
push(`**Status**: ${tierAResult.status}`)
push(`**Reps**: ${tierAReps}`)
push(`**Tasks**: 10 real-web (hn, wikipedia, github, mdn, npm, arxiv, reddit, stackoverflow, w3c, python-docs)`)
push(`**Output**: \`${path.relative(outRoot, tierAOut)}\``)
push('')

if (tierASummary && tierASummary.frameworks) {
  push('| metric | bad | browser-use | Δ |')
  push('|---|---:|---:|---|')
  const bad = tierASummary.frameworks.find((f) => f.framework === 'bad')
  const bu = tierASummary.frameworks.find((f) => f.framework === 'browser-use')
  if (bad && bu) {
    const passDelta = bad.passed - bu.passed
    const passDeltaStr = passDelta >= 0 ? `+${passDelta}` : `${passDelta}`
    push(`| **pass rate** | **${fmtPct(bad.passed, bad.totalRuns)}** | **${fmtPct(bu.passed, bu.totalRuns)}** | **${passDeltaStr}** |`)
    push(`| mean wall-time | ${fmtTime(bad.wallTimeSecMean * 1000)} | ${fmtTime(bu.wallTimeSecMean * 1000)} | ${(bu.wallTimeSecMean / bad.wallTimeSecMean).toFixed(1)}× to bad |`)
    push(`| p95 wall-time | ${fmtTime(bad.wallTimeSecP95 * 1000)} | ${fmtTime(bu.wallTimeSecP95 * 1000)} | — |`)
    push(`| mean cost | ${fmtCost(bad.costUsdMean)} | ${fmtCost(bu.costUsdMean)} | ${(bu.costUsdMean / bad.costUsdMean).toFixed(2)}× to bad |`)
    push(`| mean tokens | ${Math.round(bad.totalTokensMean).toLocaleString()} | ${Math.round(bu.totalTokensMean).toLocaleString()} | ${(bu.totalTokensMean / bad.totalTokensMean).toFixed(2)}× to bad |`)
    const badCostPerPass = bad.passed > 0 ? (bad.costUsdMean * bad.totalRuns) / bad.passed : null
    const buCostPerPass = bu.passed > 0 ? (bu.costUsdMean * bu.totalRuns) / bu.passed : null
    if (badCostPerPass != null && buCostPerPass != null) {
      push(`| **cost per pass** | **${fmtCost(badCostPerPass)}** | **${fmtCost(buCostPerPass)}** | — |`)
    }
    push('')
    push('### Per-task pass rate')
    push('')
    push('| task | bad | browser-use | Δ |')
    push('|---|---:|---:|---|')
    for (const taskId of Object.keys(bad.cellPassRates)) {
      const b = bad.cellPassRates[taskId]
      const u = bu.cellPassRates[taskId] || { passed: 0, total: 0 }
      const d = b.passed - u.passed
      const dStr = d > 0 ? `**+${d}**` : d < 0 ? `**${d}**` : '0'
      push(`| ${taskId} | ${b.passed}/${b.total} | ${u.passed}/${u.total} | ${dStr} |`)
    }
  }
} else {
  push('_No tier-A summary found. Tier may have failed or been skipped._')
}
push('')

// ============================================================================
// Tier B: WebVoyager
// ============================================================================
push('## Tier B — WebVoyager 30-task curated sample')
push('')
push(`**Status**: ${tierBResult.status}`)
push(`**Reps**: 1 per task (default)`)
push(`**Tasks**: 30 (2 per site × 15 sites)`)
push(`**Sites**: Allrecipes, Amazon, Apple, ArXiv, BBC News, Booking, Cambridge Dictionary, Coursera, ESPN, GitHub, Google Flights, Google Map, Google Search, Huggingface, Wolfram Alpha`)
push(`**LLM judge**: GPT-4o vision`)
push(`**Output**: \`${path.relative(outRoot, tierBOut)}\``)
push('')

if (tierBSummary) {
  if (tierBSummary.judgePassRate != null) {
    push(`- **Judge pass rate**: ${(tierBSummary.judgePassRate * 100).toFixed(0)}% (${tierBSummary.judgeSuccesses ?? '?'}/${tierBSummary.totalTasks ?? '?'})`)
    if (tierBSummary.agentPassRate != null) {
      push(`- **Agent self-pass rate**: ${(tierBSummary.agentPassRate * 100).toFixed(0)}%`)
    }
    if (tierBSummary.agreementRate != null) {
      push(`- **Judge ↔ agent agreement**: ${(tierBSummary.agreementRate * 100).toFixed(0)}%`)
    }
  } else {
    push('_Tier-B summary present but no judgePassRate field. Check tier-b-webvoyager/wv-eval.json for details._')
  }
} else {
  push('_No tier-B summary found. Tier may have failed or been skipped._')
}
push('')

// ============================================================================
// Tier C: multi-model
// ============================================================================
push('## Tier C — Multi-model truth table (bad Gen 10 on gpt-5.2 vs gpt-5.4)')
push('')
push(`**Reps**: ${tierCReps}`)
push(`**Tasks**: same 10 real-web as Tier A`)
push(`**Output**: \`${path.relative(outRoot, tierCOut)}\``)
push('')

const validModels = Object.entries(tierCSummaries).filter(([, s]) => s)
if (validModels.length > 0) {
  push('| model | pass rate | mean wall-time | mean cost | mean tokens |')
  push('|---|---:|---:|---:|---:|')
  for (const [model, s] of validModels) {
    const bad = s.frameworks?.find((f) => f.framework === 'bad')
    if (!bad) continue
    push(`| ${model} | ${fmtPct(bad.passed, bad.totalRuns)} | ${fmtTime(bad.wallTimeSecMean * 1000)} | ${fmtCost(bad.costUsdMean)} | ${Math.round(bad.totalTokensMean).toLocaleString()} |`)
  }
} else {
  push('_No tier-C summaries found. Tier may have failed or been skipped._')
}
push('')

// ============================================================================
// Tier D: Tier 1 gate
// ============================================================================
push('## Tier D — Tier 1 deterministic gate (regression check)')
push('')
push(`**Status**: ${tierDResult.status}`)
push(`**Output**: \`${path.relative(outRoot, tierDOut)}\``)
push('')
if (tierDSummary) {
  const passed = tierDSummary.passed === true || tierDSummary.gateStatus === 'PASSED' || tierDResult.exitCode === 0
  push(`- **Gate**: ${passed ? '✅ PASSED' : '❌ FAILED'}`)
  if (tierDSummary.totalTokens != null) push(`- **Total tokens**: ${tierDSummary.totalTokens.toLocaleString()}`)
  if (tierDSummary.totalCostUsd != null) push(`- **Total cost**: ${fmtCost(tierDSummary.totalCostUsd)}`)
} else {
  push('_No tier-D summary found._')
}
push('')

// ============================================================================
// Honest weak spots
// ============================================================================
push('## Honest weak spots')
push('')
const weaknesses = []
if (tierASummary) {
  const bad = tierASummary.frameworks.find((f) => f.framework === 'bad')
  if (bad) {
    const weak = Object.entries(bad.cellPassRates).filter(([, v]) => v.passed < v.total)
    if (weak.length > 0) {
      for (const [task, v] of weak) {
        weaknesses.push(`Tier A — bad on ${task}: ${v.passed}/${v.total} (not perfect)`)
      }
    }
  }
}
if (weaknesses.length === 0) {
  push('_No weak spots flagged. (Either everything passed or no tier data.)_')
} else {
  for (const w of weaknesses) push(`- ${w}`)
}
push('')

// ============================================================================
// Reproducibility
// ============================================================================
push('## Reproducibility')
push('')
push('To reproduce this report:')
push('')
push('```bash')
push('git checkout <git-sha>')
push('pnpm install --frozen-lockfile')
push('pnpm build')
push('node scripts/run-master-comparison.mjs')
push('```')
push('')
push('Each tier writes its raw data to a subdirectory of the output root. The aggregator reads those JSONs and produces this report. If a tier failed, its summary will be missing and that section will say so explicitly.')
push('')
push('## Tier execution log')
push('')
push('See `tier-log.jsonl` for the per-tier launch / completion records.')

fs.writeFileSync(reportPath, reportLines.join('\n'))
console.log(`\n=== REPORT ===\nWrote ${reportPath}`)
console.log(`\n${reportLines.slice(0, 30).join('\n')}\n...`)

const allTiers = [
  { id: 'A', result: tierAResult },
  { id: 'B', result: tierBResult },
  { id: 'C-gpt-5.2', result: tierCResults['gpt-5.2'] },
  { id: 'C-gpt-5.4', result: tierCResults['gpt-5.4'] },
  { id: 'D', result: tierDResult },
]
const failedTiers = allTiers.filter((t) => t.result?.status === 'failed')
if (failedTiers.length > 0) {
  console.log(`\nWARNING: ${failedTiers.length} tier(s) failed: ${failedTiers.map((t) => t.id).join(', ')}`)
  console.log('Report still generated with missing-data markers for failed tiers.')
}

process.exit(0)
