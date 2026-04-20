#!/usr/bin/env node

/**
 * WebVoyager benchmark runner — download, convert, run, evaluate.
 *
 * Usage:
 *   # Full pipeline (downloads data if needed, converts, runs, evaluates):
 *   node bench/external/webvoyager/run.mjs
 *
 *   # Just a subset:
 *   node bench/external/webvoyager/run.mjs --site Google_Flights --max-tasks 5
 *
 *   # Run with specific model/profile:
 *   node bench/external/webvoyager/run.mjs --model gpt-5.4 --benchmark-profile webbench-stealth
 *
 *   # Skip eval (just run agent):
 *   node bench/external/webvoyager/run.mjs --no-eval
 *
 *   # Evaluate existing results:
 *   node bench/external/webvoyager/run.mjs --eval-only --results ./agent-results/wv-xxx
 *
 *   # Cost estimate:
 *   node bench/external/webvoyager/run.mjs --estimate
 */

import fs from 'node:fs'
import path from 'node:path'
import { execSync, spawn } from 'node:child_process'

const __dir = path.dirname(new URL(import.meta.url).pathname)
const rootDir = path.resolve(__dir, '../../..')
const argv = process.argv.slice(2)

const getArg = (name, fallback) => {
  const idx = argv.indexOf(`--${name}`)
  if (idx === -1) return fallback
  return argv[idx + 1]
}
const hasFlag = (name) => argv.includes(`--${name}`)

const model = getArg('model', 'gpt-5.4')
const benchmarkProfile = getArg('benchmark-profile', 'webvoyager')
const site = getArg('site')
const maxTasks = getArg('max-tasks', '0')
const concurrency = getArg('concurrency', '3')
const scenarioConcurrency = getArg('scenario-concurrency', '2')
// Gen 30 R3: let callers route LLM calls through a custom endpoint
// (e.g. router.tangle.tools) with a non-OpenAI model id. These flags pass
// straight through to scenario-track → bad run.
const providerArg = getArg('provider')
const baseUrlArg = getArg('base-url')
const apiKeyArg = getArg('api-key')
const noEval = hasFlag('no-eval')
const evalOnly = hasFlag('eval-only')
const evalResults = getArg('results')
const estimate = hasFlag('estimate')
const outDir = getArg('out', path.resolve(rootDir, `agent-results/wv-${Date.now()}`))
// Gen 11: --cases-file lets the master comparison runner pass a curated
// subset (e.g. bench/external/webvoyager/curated-30.json) without overwriting
// the canonical converted cases.json.
const casesFileOverride = getArg('cases-file')

const TASKS_URL = 'https://raw.githubusercontent.com/MinorJerry/WebVoyager/main/data/WebVoyager_data.jsonl'
const PATCHES_URL = 'https://raw.githubusercontent.com/magnitudedev/webvoyager/main/data/patches.json'
const tasksPath = path.join(__dir, 'tasks.jsonl')
const patchesPath = path.join(__dir, 'patches.json')
const casesPath = path.join(__dir, 'cases.json')

// ── Step 1: Download data ───────────────────────────────────────────────────

function download(url, dest) {
  if (fs.existsSync(dest)) {
    console.log(`  ${path.basename(dest)} exists, skipping download`)
    return
  }
  console.log(`  Downloading ${path.basename(dest)}...`)
  execSync(`curl -sL "${url}" -o "${dest}"`, { cwd: rootDir })
}

// ── Step 2: Convert tasks ───────────────────────────────────────────────────

function convertTasks() {
  const args = ['bench/external/webvoyager/convert-tasks.mjs', '--apply-patches', '--exclude-removed']
  if (site) args.push('--site', site)
  if (maxTasks !== '0') args.push('--max-tasks', maxTasks)
  args.push('--out', casesPath)
  execSync(`node ${args.join(' ')}`, { cwd: rootDir, stdio: 'inherit' })
}

// ── Step 3: Estimate cost ───────────────────────────────────────────────────

function estimateCost() {
  const cases = JSON.parse(fs.readFileSync(activeCasesPath, 'utf8'))
  const costPerCase = 0.25 // based on WEBBENCH empirical average
  const evalCostPerCase = 0.02 // GPT-4o judge per case
  const total = cases.length
  const runCost = total * costPerCase
  const evalCost = total * evalCostPerCase
  console.log(`\nCost estimate (${total} tasks):`)
  console.log(`  Agent runs:   ~$${runCost.toFixed(2)} (${total} × $${costPerCase}/case)`)
  console.log(`  Evaluation:   ~$${evalCost.toFixed(2)} (${total} × $${evalCostPerCase}/case)`)
  console.log(`  Total:        ~$${(runCost + evalCost).toFixed(2)}`)
  console.log(`  Duration:     ~${Math.ceil(total / Number(concurrency) * 0.7)}min at concurrency=${concurrency}`)
}

// ── Step 4: Run agent ───────────────────────────────────────────────────────

function runAgent() {
  return new Promise((resolve, reject) => {
    const args = [
      'scripts/run-scenario-track.mjs',
      '--cases', activeCasesPath,
      '--model', model,
      '--benchmark-profile', benchmarkProfile,
      '--modes', 'fast-explore',
      '--concurrency', scenarioConcurrency,
      '--out', outDir,
      '--memory',
      '--memory-isolation', 'per-run',
    ]
    if (providerArg) args.push('--provider', providerArg)
    if (baseUrlArg) args.push('--base-url', baseUrlArg)
    if (apiKeyArg) args.push('--api-key', apiKeyArg)

    console.log(`\nRunning agent: node ${args.join(' ')}`)
    const proc = spawn('node', args, { cwd: rootDir, stdio: 'inherit' })
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Agent run exited with code ${code}`))
    })
  })
}

// ── Step 5: Evaluate ────────────────────────────────────────────────────────

function evaluate(dir) {
  return new Promise((resolve, reject) => {
    const args = [
      'bench/external/webvoyager/evaluate.mjs',
      '--results', dir,
      '--concurrency', '5',
    ]

    console.log(`\nEvaluating: node ${args.join(' ')}`)
    const proc = spawn('node', args, { cwd: rootDir, stdio: 'inherit' })
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Evaluation exited with code ${code}`))
    })
  })
}

// ── Main ────────────────────────────────────────────────────────────────────

// Gen 11: when --cases-file is given, point cases.json at the override file
// for the duration of this run by writing a sibling cases-active.json. The
// runner downstream uses casesPath, so we just point that variable.
let activeCasesPath = casesPath
if (casesFileOverride) {
  activeCasesPath = path.resolve(casesFileOverride)
  if (!fs.existsSync(activeCasesPath)) {
    console.error(`--cases-file not found: ${activeCasesPath}`)
    process.exit(1)
  }
}

async function main() {
  console.log('WebVoyager Benchmark Runner')
  console.log('══════════════════════════════════════')

  if (evalOnly) {
    if (!evalResults) {
      console.error('--eval-only requires --results <dir>')
      process.exit(1)
    }
    await evaluate(evalResults)
    return
  }

  if (casesFileOverride) {
    console.log(`\nUsing curated cases file: ${activeCasesPath}`)
    const curated = JSON.parse(fs.readFileSync(activeCasesPath, 'utf-8'))
    console.log(`  ${curated.length} cases loaded`)
  } else {
    // Download data
    console.log('\n1. Downloading WebVoyager data...')
    download(TASKS_URL, tasksPath)
    download(PATCHES_URL, patchesPath)

    // Convert
    console.log('\n2. Converting tasks...')
    convertTasks()
  }

  if (estimate) {
    estimateCost()
    return
  }

  // Run
  console.log('\n3. Running agent...')
  await runAgent()

  // Evaluate
  if (!noEval) {
    console.log('\n4. Evaluating with LLM judge...')
    await evaluate(outDir)
  }

  console.log('\nDone. Results:', outDir)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
