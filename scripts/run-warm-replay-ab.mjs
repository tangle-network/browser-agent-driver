/**
 * Warm-trajectory A/B for --replay (the speed-v1 `workflow-replay` hypothesis).
 *
 * Replay only helps a WARM store (per-run memory isolation shows zero benefit),
 * so this runs two phases against ONE shared memory dir:
 *   Phase A (baseline) — N reps, replay OFF. Measures the baseline AND records
 *                        successful trajectories into the shared store.
 *   Phase B (replay)   — N reps, replay ON, same warm store. Measures replay.
 * The only delta between phases is --replay, so the decide-cost difference is
 * replay's effect. Compares decideLlmCalls / totalDecideMs / duration / pass.
 *
 * gpt-5.4 is the default model but its key is dead, so this defaults to
 * --provider claude-code (no key). That validates the MECHANISM, not the
 * default-model promotion gate — report the model caveat.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { startStaticFixtureServer } from './lib/static-fixture-server.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d
}

const casesPath = path.resolve(arg('cases', 'bench/scenarios/cases/local-deterministic.json'))
const reps = Math.max(1, Number.parseInt(arg('reps', '3'), 10))
const provider = arg('provider', 'claude-code')
const model = arg('model', 'sonnet') // claude-code knows: opus | sonnet | haiku
const baseUrl = arg('base-url', null) // OpenAI-compat endpoint (e.g. router.tangle.tools/v1)
const maxTurns = arg('max-turns', '20')
const timeoutMs = arg('timeout', '180000')
const caseFilter = arg('case-filter', null) // optional substring on case id
const outRoot = path.resolve(arg('out', `.evolve/warm-replay-${Date.now()}`))
const memDir = path.join(outRoot, 'mem') // ONE shared store across both phases

fs.mkdirSync(memDir, { recursive: true })

// --- load + (optionally) filter cases, substitute the fixture base URL --------
const raw = fs.readFileSync(casesPath, 'utf-8')
const needsFixtures = raw.includes('__FIXTURE_BASE_URL__')

function readCaseMeta(text) {
  const j = JSON.parse(text)
  const list = Array.isArray(j) ? j : (j.cases ?? j.tests ?? [])
  return { wrapper: Array.isArray(j) ? null : j, list }
}

function extractPhaseTimings(reportPath) {
  if (!fs.existsSync(reportPath)) return []
  const r = JSON.parse(fs.readFileSync(reportPath, 'utf-8'))
  const results = r.results ?? []
  return results.map((res) => {
    const pt = res.phaseTimings ?? res.agentResult?.phaseTimings ?? {}
    return {
      id: res.testCase?.id ?? res.testCase?.name ?? '?',
      ok: Boolean(res.agentSuccess ?? res.verified),
      decideLlmCalls: pt.decideLlmCalls ?? null,
      decideSkips: pt.decideSkips ?? null,
      totalDecideMs: pt.totalDecideMs ?? null,
      turns: res.turnsUsed ?? res.agentResult?.turns?.length ?? null,
      durationMs: res.durationMs ?? null,
    }
  })
}

function runOnce(repDir, { replay }) {
  fs.mkdirSync(repDir, { recursive: true })
  const args = [
    'dist/cli.js', 'run',
    '--cases', tmpCases,
    '--provider', provider,
    '--model', model,
    '--memory', '--memory-dir', memDir,
    '--sink', repDir,
    '--headless',
    '--max-turns', String(maxTurns),
    '--timeout', String(timeoutMs),
  ]
  // Route through an OpenAI-compatible gateway when given (api key via env, not argv).
  if (baseUrl) args.push('--base-url', baseUrl)
  if (replay) args.push('--replay')
  return new Promise((resolve) => {
    const proc = spawn('node', args, { cwd: ROOT, env: process.env, stdio: 'inherit' })
    proc.on('exit', (code) => resolve(extractPhaseTimings(path.join(repDir, 'report.json'))))
    proc.on('error', () => resolve([]))
  })
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
function summarize(rows) {
  const flat = rows.flat().filter(Boolean)
  const num = (k) => flat.map((r) => r[k]).filter((v) => typeof v === 'number')
  return {
    runs: flat.length,
    passRate: flat.length ? flat.filter((r) => r.ok).length / flat.length : 0,
    decideLlmCalls: mean(num('decideLlmCalls')),
    decideSkips: mean(num('decideSkips')),
    totalDecideMs: mean(num('totalDecideMs')),
    durationMs: mean(num('durationMs')),
    turns: mean(num('turns')),
  }
}

let tmpCases
const server = needsFixtures ? await startStaticFixtureServer(path.join(ROOT, 'bench/fixtures')) : null
try {
  let text = raw
  if (server) text = text.replaceAll('__FIXTURE_BASE_URL__', server.baseUrl)
  if (caseFilter) {
    const { wrapper, list } = readCaseMeta(text)
    const kept = list.filter((c) => String(c.id ?? c.name ?? '').includes(caseFilter))
    text = JSON.stringify(wrapper ? { ...wrapper, cases: kept } : kept)
  }
  tmpCases = path.join(outRoot, 'cases.resolved.json')
  fs.writeFileSync(tmpCases, text)
  const nCases = readCaseMeta(text).list.length
  console.log(`warm-replay-ab: ${nCases} case(s) × ${reps} reps × 2 phases | provider=${provider} model=${model}`)
  console.log(`  shared memory store: ${memDir}\n`)

  const baseRows = []
  for (let r = 1; r <= reps; r++) {
    console.log(`\n=== PHASE A (baseline, replay OFF) rep ${r}/${reps} ===`)
    baseRows.push(await runOnce(path.join(outRoot, `base-rep${r}`), { replay: false }))
  }
  const replayRows = []
  for (let r = 1; r <= reps; r++) {
    console.log(`\n=== PHASE B (replay ON, warm store) rep ${r}/${reps} ===`)
    replayRows.push(await runOnce(path.join(outRoot, `replay-rep${r}`), { replay: true }))
  }

  const A = summarize(baseRows)
  const B = summarize(replayRows)
  const pct = (a, b) => (a ? `${(((b - a) / a) * 100).toFixed(0)}%` : 'n/a')
  const out = { casesPath, reps, provider, model, baseline: A, replay: B, generatedFromWarmStore: memDir }
  fs.writeFileSync(path.join(outRoot, 'warm-replay-result.json'), JSON.stringify(out, null, 2))

  console.log(`\n\n================ WARM-REPLAY A/B (${provider}/${model}) ================`)
  console.log(`reps=${reps}  cases=${readCaseMeta(fs.readFileSync(tmpCases, 'utf-8')).list.length}\n`)
  const row = (label, a, b) => console.log(`| ${label.padEnd(16)} | ${String(a).padStart(10)} | ${String(b).padStart(10)} | ${pct(Number(a), Number(b)).padStart(6)} |`)
  console.log('| metric           |   baseline |     replay |     Δ |')
  console.log('|------------------|------------|------------|-------|')
  row('decideLlmCalls', A.decideLlmCalls.toFixed(2), B.decideLlmCalls.toFixed(2))
  row('decideSkips', A.decideSkips.toFixed(2), B.decideSkips.toFixed(2))
  row('totalDecideMs', A.totalDecideMs.toFixed(0), B.totalDecideMs.toFixed(0))
  row('duration ms', A.durationMs.toFixed(0), B.durationMs.toFixed(0))
  row('turns', A.turns.toFixed(2), B.turns.toFixed(2))
  console.log(`\n  pass rate: baseline ${(A.passRate * 100).toFixed(0)}%  →  replay ${(B.passRate * 100).toFixed(0)}%`)
  console.log(`  result → ${path.join(outRoot, 'warm-replay-result.json')}`)
} finally {
  if (server) await server.close()
}
