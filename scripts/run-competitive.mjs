#!/usr/bin/env node
/**
 * Competitive bench harness — head-to-head comparison of `bad` against
 * other browser agent frameworks (browser-use, Stagehand, ...).
 *
 * Single entry point for the unified, statistically-rigorous cross-tool
 * comparison. Per the rigor protocol in docs/EVAL-RIGOR.md it enforces
 * ≥3 reps per (framework × task) cell unless --allow-quick-check is set.
 *
 * Usage:
 *   pnpm bench:compete -- \
 *     --frameworks bad \
 *     --tasks form-fill-multi-step \
 *     --reps 3 \
 *     --out agent-results/competitive-<timestamp>
 *
 * Output:
 *   <out>/runs.jsonl       — one JSON line per (framework, task, rep) cell
 *   <out>/runs.csv         — flat CSV for graphing tools
 *   <out>/summary.json     — per-cell stats + cross-framework deltas + verdicts
 *   <out>/comparison.md    — readable markdown report
 *
 * Rigor:
 *   - Exits non-zero on --reps < 3 unless --allow-quick-check.
 *   - Every metric reported as mean (min-max) with N reps.
 *   - Wilson 95% CI on pass rate, bootstrap 95% CI on delta-of-means,
 *     Cohen's d effect size, Mann-Whitney U two-sample test.
 *   - Spread-test verdict per metric (CLAUDE.md rule #2).
 */

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { startStaticFixtureServer } from './lib/static-fixture-server.mjs'
import {
  describe as statsDescribe,
  wilsonInterval,
  bootstrapDiff95,
  cohenD,
  classifyEffectSize,
  mannWhitneyU,
  spreadVerdict,
  mean,
} from './lib/stats.mjs'

const argv = process.argv.slice(2)
const getArg = (name, fallback = undefined) => {
  const idx = argv.indexOf(`--${name}`)
  if (idx === -1) return fallback
  if (idx === argv.length - 1) return 'true'
  return argv[idx + 1]
}
const hasFlag = (name) => argv.includes(`--${name}`)

const rootDir = path.resolve(path.join(new URL('.', import.meta.url).pathname, '..'))
const frameworksArg = getArg('frameworks', 'bad')
const tasksArg = getArg('tasks')
const reps = Math.max(1, Number.parseInt(getArg('reps', '3'), 10))
const allowQuickCheck = hasFlag('allow-quick-check')
const baselineFramework = getArg('baseline', 'bad')
const outRoot = path.resolve(getArg('out', `./agent-results/competitive-${Date.now()}`))
const model = getArg('model', 'gpt-5.2')
const config = getArg('config')
const tasksDir = path.join(rootDir, 'bench', 'competitive', 'tasks')
const adaptersDir = path.join(rootDir, 'bench', 'competitive', 'adapters')

if (reps < 3 && !allowQuickCheck) {
  console.error(
    `competitive: ERROR reps=${reps} but CLAUDE.md mandates ≥3 reps for any speed/turn/cost claim.\n` +
    `  - For genuine validation: --reps 3 (or more)\n` +
    `  - For a quick smoke check that you will NOT cite anywhere: --allow-quick-check`,
  )
  process.exit(2)
}
if (reps < 3 && allowQuickCheck) {
  console.warn(`competitive: --allow-quick-check is on (reps=${reps}). DO NOT cite this run as validation.`)
}

if (!tasksArg) {
  console.error('competitive: --tasks <id1,id2,...> is required')
  process.exit(1)
}

const frameworkIds = frameworksArg.split(',').map((s) => s.trim()).filter(Boolean)
const taskIds = tasksArg.split(',').map((s) => s.trim()).filter(Boolean)

fs.mkdirSync(outRoot, { recursive: true })
const runsJsonlPath = path.join(outRoot, 'runs.jsonl')
fs.writeFileSync(runsJsonlPath, '') // truncate

// Load tasks
const tasks = taskIds.map((id) => {
  const taskPath = path.join(tasksDir, `${id}.json`)
  if (!fs.existsSync(taskPath)) {
    console.error(`competitive: task not found: ${taskPath}`)
    process.exit(1)
  }
  return JSON.parse(fs.readFileSync(taskPath, 'utf-8'))
})

// Load adapters
const adapters = {}
for (const fw of frameworkIds) {
  const adapterPath = path.join(adaptersDir, `${fw}.mjs`)
  if (!fs.existsSync(adapterPath)) {
    console.error(`competitive: adapter not found: ${adapterPath}`)
    console.error(`  available adapters: ${listAdapters(adaptersDir).join(', ')}`)
    process.exit(1)
  }
  adapters[fw] = await import(adapterPath)
}

// Detect framework availability
const detection = {}
for (const [fw, adapter] of Object.entries(adapters)) {
  detection[fw] = adapter.detect ? adapter.detect(rootDir) : { available: true }
  if (!detection[fw].available) {
    console.warn(`competitive: framework "${fw}" is NOT available: ${detection[fw].reason}`)
  } else if (detection[fw].version) {
    console.log(`competitive: framework "${fw}" available (version ${detection[fw].version})`)
  }
}
const runnableFrameworks = Object.entries(detection)
  .filter(([, d]) => d.available)
  .map(([fw]) => fw)
if (runnableFrameworks.length === 0) {
  console.error('competitive: no available frameworks to run')
  process.exit(3)
}

// Start a single shared fixture server for any task that uses __FIXTURE_BASE_URL__.
const needsFixtureServer = tasks.some(
  (t) => typeof t.startUrl === 'string' && t.startUrl.includes('__FIXTURE_BASE_URL__'),
)
let fixtureServer = null
let fixtureBaseUrl = undefined
if (needsFixtureServer) {
  const fixturesDir = path.join(rootDir, 'bench', 'fixtures')
  fixtureServer = await startStaticFixtureServer(fixturesDir)
  fixtureBaseUrl = fixtureServer.baseUrl
  console.log(`competitive: started fixture server at ${fixtureBaseUrl}`)
}

const allRuns = []
try {
  for (const task of tasks) {
    for (const fw of runnableFrameworks) {
      console.log(`\n=== ${fw} × ${task.id} (${reps} reps) ===`)
      for (let rep = 1; rep <= reps; rep++) {
        const runId = `${fw}-${task.id}-rep${String(rep).padStart(3, '0')}`
        const cellOut = path.join(outRoot, fw, task.id)
        fs.mkdirSync(cellOut, { recursive: true })
        console.log(`--- rep ${rep}/${reps} → ${cellOut}/${runId} ---`)
        const result = await adapters[fw].runTask(task, {
          repoRoot: rootDir,
          outDir: cellOut,
          fixtureBaseUrl,
          model,
          config,
          runId,
        })
        result.rep = rep
        allRuns.push(result)
        fs.appendFileSync(runsJsonlPath, JSON.stringify(result) + '\n')
        console.log(
          `   ${result.success ? '✓ pass' : '✗ fail'}` +
          ` · ${(result.wallTimeMs / 1000).toFixed(1)}s` +
          ` · ${result.turnCount ?? '?'} turns` +
          ` · ${result.totalTokens ?? 0} tokens` +
          ` · $${(result.costUsd ?? 0).toFixed(4)}` +
          (result.errorReason ? ` · reason=${result.errorReason}` : ''),
        )
      }
    }
  }
} finally {
  if (fixtureServer) {
    try { await fixtureServer.close() } catch {}
  }
}

// ── Aggregate per (framework, task) cell ───────────────────────────────

const cellStats = {}
for (const run of allRuns) {
  const key = `${run.framework}|${run.taskId}`
  if (!cellStats[key]) {
    cellStats[key] = { framework: run.framework, taskId: run.taskId, runs: [] }
  }
  cellStats[key].runs.push(run)
}
for (const cell of Object.values(cellStats)) {
  const r = cell.runs
  const passed = r.filter((x) => x.success).length
  const wallTimes = r.map((x) => x.wallTimeMs / 1000) // seconds
  const turns = r.map((x) => x.turnCount).filter((x) => Number.isFinite(x))
  const llmCalls = r.map((x) => x.llmCallCount).filter((x) => Number.isFinite(x))
  const tokens = r.map((x) => x.totalTokens).filter((x) => Number.isFinite(x))
  const inputTokens = r.map((x) => x.inputTokens).filter((x) => Number.isFinite(x))
  const outputTokens = r.map((x) => x.outputTokens).filter((x) => Number.isFinite(x))
  const cachedTokens = r.map((x) => x.cachedInputTokens).filter((x) => Number.isFinite(x))
  const costs = r.map((x) => x.costUsd).filter((x) => Number.isFinite(x))

  cell.passRate = {
    rate: passed / r.length,
    passed,
    total: r.length,
    wilson95: wilsonInterval(passed, r.length),
  }
  cell.wallTimeSec = statsDescribe(wallTimes)
  cell.turns = statsDescribe(turns)
  cell.llmCalls = statsDescribe(llmCalls)
  cell.totalTokens = statsDescribe(tokens)
  cell.inputTokens = statsDescribe(inputTokens)
  cell.outputTokens = statsDescribe(outputTokens)
  cell.cachedInputTokens = statsDescribe(cachedTokens)
  cell.costUsd = statsDescribe(costs)
  cell.cacheHitRate =
    inputTokens.length > 0 && cachedTokens.length === inputTokens.length
      ? mean(cachedTokens) / Math.max(1, mean(inputTokens))
      : 0
}

// ── Cross-framework comparison per task ────────────────────────────────

const comparisons = {}
for (const task of tasks) {
  const baselineCell = cellStats[`${baselineFramework}|${task.id}`]
  if (!baselineCell) continue
  const challengers = Object.values(cellStats).filter(
    (c) => c.taskId === task.id && c.framework !== baselineFramework,
  )
  if (challengers.length === 0) continue
  const taskComparison = {
    task: task.id,
    baseline: baselineFramework,
    challengers: [],
  }
  for (const ch of challengers) {
    const chWall = ch.runs.map((r) => r.wallTimeMs / 1000)
    const blWall = baselineCell.runs.map((r) => r.wallTimeMs / 1000)
    const chCost = ch.runs.map((r) => r.costUsd ?? 0)
    const blCost = baselineCell.runs.map((r) => r.costUsd ?? 0)
    const chTurns = ch.runs.map((r) => r.turnCount).filter(Number.isFinite)
    const blTurns = baselineCell.runs.map((r) => r.turnCount).filter(Number.isFinite)
    const chTokens = ch.runs.map((r) => r.totalTokens ?? 0)
    const blTokens = baselineCell.runs.map((r) => r.totalTokens ?? 0)

    taskComparison.challengers.push({
      framework: ch.framework,
      wallTime: compareMetric(chWall, blWall, 'lower'),
      cost: compareMetric(chCost, blCost, 'lower'),
      turns: chTurns.length === blTurns.length && chTurns.length > 0 ? compareMetric(chTurns, blTurns, 'lower') : null,
      tokens: compareMetric(chTokens, blTokens, 'lower'),
      passRate: comparePassRate(ch.passRate, baselineCell.passRate),
    })
  }
  comparisons[task.id] = taskComparison
}

function compareMetric(challenger, baseline, direction) {
  if (challenger.length === 0 || baseline.length === 0) return null
  const cMean = mean(challenger)
  const bMean = mean(baseline)
  const delta = cMean - bMean
  const deltaPct = bMean !== 0 ? (delta / bMean) * 100 : 0
  return {
    challengerMean: cMean,
    baselineMean: bMean,
    delta,
    deltaPct,
    bootstrap95Delta: bootstrapDiff95(challenger, baseline, 2000, 31),
    cohenD: cohenD(challenger, baseline),
    cohenDClass: classifyEffectSize(cohenD(challenger, baseline)),
    mannWhitney: mannWhitneyU(challenger, baseline),
    verdict: spreadVerdict(challenger, baseline, direction),
  }
}

function comparePassRate(chPass, blPass) {
  return {
    challenger: chPass,
    baseline: blPass,
    delta: chPass.rate - blPass.rate,
  }
}

// ── Write summary ──────────────────────────────────────────────────────

const summary = {
  generatedAt: new Date().toISOString(),
  gitSha: safeGitSha(),
  repoVersion: safeRepoVersion(),
  reps,
  model,
  baselineFramework,
  frameworks: frameworkIds,
  detection,
  runnableFrameworks,
  tasks: tasks.map((t) => ({ id: t.id, name: t.name, tags: t.tags ?? [] })),
  cells: Object.values(cellStats),
  comparisons,
  rigorWarnings: reps < 3 ? ['reps < 3 — CLAUDE.md mandates ≥3 for any cited claim'] : [],
}
fs.writeFileSync(path.join(outRoot, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
fs.writeFileSync(path.join(outRoot, 'comparison.md'), renderMarkdown(summary))
writeCsv(path.join(outRoot, 'runs.csv'), allRuns)

console.log('\n' + renderMarkdown(summary))
console.log(`\nCompetitive summary: ${path.join(outRoot, 'summary.json')}`)
console.log(`Comparison markdown: ${path.join(outRoot, 'comparison.md')}`)
console.log(`Per-rep CSV:         ${path.join(outRoot, 'runs.csv')}`)

const anyFailed = allRuns.some((r) => !r.success)
process.exit(anyFailed ? 1 : 0)

// ── Helpers ────────────────────────────────────────────────────────────

function listAdapters(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.mjs') && !f.startsWith('_'))
    .map((f) => f.replace(/\.mjs$/, ''))
}

function safeGitSha() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: rootDir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return null
  }
}

function safeRepoVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8')).version
  } catch {
    return null
  }
}

function renderMarkdown(s) {
  const lines = []
  lines.push('# Competitive bench summary')
  lines.push('')
  lines.push(`- Generated: ${s.generatedAt}`)
  lines.push(`- Git SHA: ${s.gitSha ?? 'unknown'} (${s.repoVersion ?? '?'})`)
  lines.push(`- Model: ${s.model}`)
  lines.push(`- Reps per cell: ${s.reps}`)
  lines.push(`- Baseline framework: \`${s.baselineFramework}\``)
  lines.push(`- Frameworks evaluated: ${s.runnableFrameworks.map((f) => `\`${f}\``).join(', ')}`)
  if (s.rigorWarnings?.length) {
    lines.push('')
    lines.push('> ⚠ Rigor warnings:')
    for (const w of s.rigorWarnings) lines.push(`> - ${w}`)
  }

  // Detection
  lines.push('')
  lines.push('## Framework availability')
  lines.push('')
  lines.push('| framework | available | version | reason |')
  lines.push('|---|:---:|---|---|')
  for (const [fw, d] of Object.entries(s.detection)) {
    lines.push(`| \`${fw}\` | ${d.available ? '✓' : '✗'} | ${d.version ?? '—'} | ${d.reason ?? ''} |`)
  }

  // Per-cell stats
  lines.push('')
  lines.push('## Per-cell statistics')
  for (const cell of s.cells) {
    lines.push('')
    lines.push(`### \`${cell.framework}\` × \`${cell.taskId}\``)
    lines.push('')
    lines.push(`Pass rate: **${cell.passRate.passed}/${cell.passRate.total}** (${(cell.passRate.rate * 100).toFixed(0)}%) · Wilson 95% CI [${(cell.passRate.wilson95[0] * 100).toFixed(0)}%, ${(cell.passRate.wilson95[1] * 100).toFixed(0)}%]`)
    lines.push('')
    lines.push('| metric | n | mean | stddev | min | median | p95 | max |')
    lines.push('|---|---:|---:|---:|---:|---:|---:|---:|')
    lines.push(`| wall-time (s) | ${cell.wallTimeSec.n} | ${cell.wallTimeSec.mean.toFixed(1)} | ${cell.wallTimeSec.stddev.toFixed(1)} | ${cell.wallTimeSec.min.toFixed(1)} | ${cell.wallTimeSec.median.toFixed(1)} | ${cell.wallTimeSec.p95.toFixed(1)} | ${cell.wallTimeSec.max.toFixed(1)} |`)
    lines.push(`| turns | ${cell.turns.n} | ${cell.turns.mean.toFixed(1)} | ${cell.turns.stddev.toFixed(1)} | ${cell.turns.min} | ${cell.turns.median.toFixed(1)} | ${cell.turns.p95.toFixed(1)} | ${cell.turns.max} |`)
    lines.push(`| LLM calls | ${cell.llmCalls.n} | ${cell.llmCalls.mean.toFixed(1)} | ${cell.llmCalls.stddev.toFixed(1)} | ${cell.llmCalls.min} | ${cell.llmCalls.median.toFixed(1)} | ${cell.llmCalls.p95.toFixed(1)} | ${cell.llmCalls.max} |`)
    lines.push(`| total tokens | ${cell.totalTokens.n} | ${cell.totalTokens.mean.toFixed(0)} | ${cell.totalTokens.stddev.toFixed(0)} | ${cell.totalTokens.min} | ${cell.totalTokens.median.toFixed(0)} | ${cell.totalTokens.p95.toFixed(0)} | ${cell.totalTokens.max} |`)
    lines.push(`| input tokens | ${cell.inputTokens.n} | ${cell.inputTokens.mean.toFixed(0)} | ${cell.inputTokens.stddev.toFixed(0)} | ${cell.inputTokens.min} | ${cell.inputTokens.median.toFixed(0)} | ${cell.inputTokens.p95.toFixed(0)} | ${cell.inputTokens.max} |`)
    lines.push(`| output tokens | ${cell.outputTokens.n} | ${cell.outputTokens.mean.toFixed(0)} | ${cell.outputTokens.stddev.toFixed(0)} | ${cell.outputTokens.min} | ${cell.outputTokens.median.toFixed(0)} | ${cell.outputTokens.p95.toFixed(0)} | ${cell.outputTokens.max} |`)
    lines.push(`| cached tokens | ${cell.cachedInputTokens.n} | ${cell.cachedInputTokens.mean.toFixed(0)} | ${cell.cachedInputTokens.stddev.toFixed(0)} | ${cell.cachedInputTokens.min} | ${cell.cachedInputTokens.median.toFixed(0)} | ${cell.cachedInputTokens.p95.toFixed(0)} | ${cell.cachedInputTokens.max} |`)
    lines.push(`| cost ($) | ${cell.costUsd.n} | ${cell.costUsd.mean.toFixed(4)} | ${cell.costUsd.stddev.toFixed(4)} | ${cell.costUsd.min.toFixed(4)} | ${cell.costUsd.median.toFixed(4)} | ${cell.costUsd.p95.toFixed(4)} | ${cell.costUsd.max.toFixed(4)} |`)
    if (cell.cacheHitRate > 0) {
      lines.push('')
      lines.push(`Cache-hit rate (cached input / total input): **${(cell.cacheHitRate * 100).toFixed(1)}%**`)
    }
  }

  // Cross-framework comparisons
  if (Object.keys(s.comparisons).length > 0) {
    lines.push('')
    lines.push('## Cross-framework comparison')
    for (const cmp of Object.values(s.comparisons)) {
      lines.push('')
      lines.push(`### Task: \`${cmp.task}\` (baseline: \`${cmp.baseline}\`)`)
      for (const ch of cmp.challengers) {
        lines.push('')
        lines.push(`#### Challenger: \`${ch.framework}\``)
        lines.push('')
        lines.push('| metric | challenger (mean) | baseline (mean) | Δ | Δ% | bootstrap 95% CI on Δ | Cohen d | MWU p | verdict |')
        lines.push('|---|---:|---:|---:|---:|---|---:|---:|---|')
        const fmtCi = (ci) => `[${ci[0].toFixed(2)}, ${ci[1].toFixed(2)}]`
        for (const [name, m] of Object.entries({ 'wall-time (s)': ch.wallTime, 'turns': ch.turns, 'tokens': ch.tokens, 'cost ($)': ch.cost })) {
          if (!m) continue
          lines.push(`| ${name} | ${m.challengerMean.toFixed(2)} | ${m.baselineMean.toFixed(2)} | ${m.delta.toFixed(2)} | ${m.deltaPct.toFixed(1)}% | ${fmtCi(m.bootstrap95Delta)} | ${m.cohenD.toFixed(2)} (${m.cohenDClass}) | ${m.mannWhitney.p.toFixed(3)} | **${m.verdict}** |`)
        }
        lines.push('')
        lines.push(`Pass rate: \`${ch.framework}\` ${(ch.passRate.challenger.rate * 100).toFixed(0)}% (Wilson [${(ch.passRate.challenger.wilson95[0] * 100).toFixed(0)}%, ${(ch.passRate.challenger.wilson95[1] * 100).toFixed(0)}%]) vs \`${cmp.baseline}\` ${(ch.passRate.baseline.rate * 100).toFixed(0)}% (Wilson [${(ch.passRate.baseline.wilson95[0] * 100).toFixed(0)}%, ${(ch.passRate.baseline.wilson95[1] * 100).toFixed(0)}%])`)
      }
    }
  }

  return lines.join('\n')
}

function writeCsv(filePath, runs) {
  const headers = [
    'framework', 'frameworkVersion', 'taskId', 'rep', 'runId',
    'success', 'agentClaimedSuccess', 'oracleReason',
    'wallTimeMs', 'turnCount', 'llmCallCount',
    'inputTokens', 'outputTokens', 'cachedInputTokens', 'totalTokens',
    'costUsd', 'finalUrl', 'finalTitle', 'errorReason', 'exitCode',
  ]
  const lines = [headers.join(',')]
  for (const r of runs) {
    const cells = [
      r.framework, r.frameworkVersion, r.taskId, r.rep, r.runId,
      r.success, r.agentClaimedSuccess, csvEscape(r.oracleVerdict?.reason ?? ''),
      r.wallTimeMs, r.turnCount ?? '', r.llmCallCount ?? '',
      r.inputTokens ?? '', r.outputTokens ?? '', r.cachedInputTokens ?? '', r.totalTokens ?? '',
      r.costUsd ?? '', csvEscape(r.finalUrl), csvEscape(r.finalTitle), csvEscape(r.errorReason ?? ''), r.exitCode,
    ]
    lines.push(cells.join(','))
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n')
}

function csvEscape(value) {
  const s = String(value ?? '')
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replaceAll('"', '""') + '"'
  }
  return s
}
