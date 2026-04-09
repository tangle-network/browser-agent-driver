#!/usr/bin/env node

/**
 * WebVoyager evaluation harness — GPT-4V judge on trajectory screenshots + agent answer.
 *
 * Usage:
 *   node bench/external/webvoyager/evaluate.mjs --results ./agent-results/wv-run-xxx
 *   node bench/external/webvoyager/evaluate.mjs --results ./agent-results/wv-run-xxx --model gpt-4o
 *   node bench/external/webvoyager/evaluate.mjs --results ./agent-results/wv-run-xxx --dry-run
 *
 * Reads track-summary.json from the results directory, extracts trajectory
 * screenshots and agent verdicts, then runs an LLM judge to classify each
 * task as SUCCESS or FAIL.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadLocalEnvFiles } from '../../../scripts/lib/env-loader.mjs'

// Gen 11 fix: load .env so OPENAI_API_KEY is available when the LLM judge
// (which uses the openai npm package) needs it. Other runners load this
// via scripts/run-mode-baseline.mjs but evaluate.mjs is a top-level entry.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
loadLocalEnvFiles(path.resolve(__dirname, '../../..'))

const argv = process.argv.slice(2)
const getArg = (name, fallback) => {
  const idx = argv.indexOf(`--${name}`)
  if (idx === -1) return fallback
  return argv[idx + 1]
}
const hasFlag = (name) => argv.includes(`--${name}`)

const resultsDir = path.resolve(getArg('results', ''))
const evalModel = getArg('model', 'gpt-4o')
const dryRun = hasFlag('dry-run')
const concurrency = Number(getArg('concurrency', '5'))
const outFile = getArg('out', path.join(resultsDir, 'wv-eval.json'))

if (!resultsDir || !fs.existsSync(resultsDir)) {
  console.error('Usage: node evaluate.mjs --results <results-dir>')
  process.exit(1)
}

// ── Evaluation prompt (adapted from WebVoyager paper + Magnitude fork) ──────

const EVAL_SYSTEM = `You are an expert evaluator for a web browsing agent. Your task is to assess whether the agent successfully completed the given task based on the trajectory of screenshots and the agent's final answer.

Rules:
- Judge based ONLY on what is visible in the screenshots and the agent's stated answer.
- Do NOT make assumptions about information not shown.
- For multi-step tasks, ALL steps must be completed for SUCCESS.
- If the agent found the correct information but didn't navigate to the exact right page, that can still be SUCCESS if the answer is correct.
- If the agent answered with specific data (prices, names, ratings), verify it's plausible given the screenshots.
- Be strict: vague or partial answers are NOT SUCCESS.`

const EVAL_USER = (task) => `TASK: ${task}

Based on the trajectory screenshots and the agent's final answer, classify the outcome.

Respond with a JSON object:
{"reasoning": "<your analysis>", "result": "SUCCESS" or "NOT SUCCESS"}`

// ── Load results ────────────────────────────────────────────────────────────

const trackSummary = JSON.parse(
  fs.readFileSync(path.join(resultsDir, 'track-summary.json'), 'utf8'),
)

console.log(`Loaded ${trackSummary.results.length} scenario results from ${resultsDir}`)

// ── Extract trajectory data per scenario ────────────────────────────────────

function extractTrajectory(result) {
  const scenarioDir = path.dirname(result.summaryPath || '')
  const summary = result.summary

  // Find the fast-explore run (or first available)
  const run = summary?.runs?.find((r) => r.mode === 'fast-explore') || summary?.runs?.[0]
  if (!run?.reportPath) return null

  const reportPath = run.reportPath
  if (!fs.existsSync(reportPath)) return null

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  const testResult = report.results?.[0]
  if (!testResult) return null

  // Extract agent's final answer
  const agentAnswer = testResult.agentResult?.result || ''
  const goal = testResult.testCase?.goal || ''
  // Gen 11 fix: `verdict` is the agent's freeform completion text or error
  // reason, NOT a "PASS"/"FAIL" status. The actual pass signal is
  // testResult.agentSuccess (top-level) or agentResult.success.
  const passed = testResult.agentSuccess === true
    || testResult.agentResult?.success === true

  // Collect screenshot paths from turns
  const screenshots = []
  const turns = testResult.agentResult?.turns || []
  for (const turn of turns) {
    if (turn.state?.screenshot) {
      // Base64 screenshot embedded in turn
      screenshots.push({ type: 'base64', data: turn.state.screenshot })
    }
    // Check for screenshot files in the scenario directory
    const ssPath = path.join(scenarioDir, 'fast-explore', 'suite', `turn-${turn.turn}.png`)
    if (fs.existsSync(ssPath)) {
      screenshots.push({ type: 'file', path: ssPath })
    }
  }

  // Also check for screenshots in manifest
  const manifestPath = path.join(scenarioDir, 'fast-explore', 'manifest.json')
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const ssEntries = (manifest.artifacts || []).filter(
      (a) => a.type === 'screenshot' || a.path?.endsWith('.png'),
    )
    for (const entry of ssEntries) {
      const fullPath = path.resolve(path.dirname(manifestPath), entry.path)
      if (fs.existsSync(fullPath) && !screenshots.some((s) => s.path === fullPath)) {
        screenshots.push({ type: 'file', path: fullPath })
      }
    }
  }

  return {
    scenarioId: result.scenarioId,
    goal,
    agentAnswer,
    agentPassed: passed,
    screenshots,
    turns: turns.length,
  }
}

// ── LLM judge call ──────────────────────────────────────────────────────────

async function judgeTask(trajectory) {
  const { default: OpenAI } = await import('openai')
  const client = new OpenAI()

  // Build message content with screenshots
  const userContent = []

  // Add text prompt
  userContent.push({
    type: 'text',
    text: EVAL_USER(trajectory.goal) + `\n\nAGENT'S FINAL ANSWER: ${trajectory.agentAnswer}`,
  })

  // Add up to 10 screenshots (first, last, and evenly sampled middle)
  const maxScreenshots = 10
  let selected = trajectory.screenshots
  if (selected.length > maxScreenshots) {
    const indices = [0] // first
    const step = (selected.length - 1) / (maxScreenshots - 1)
    for (let i = 1; i < maxScreenshots - 1; i++) {
      indices.push(Math.round(i * step))
    }
    indices.push(selected.length - 1) // last
    selected = [...new Set(indices)].map((i) => selected[i])
  }

  for (const ss of selected) {
    if (ss.type === 'base64') {
      userContent.push({
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${ss.data}`, detail: 'low' },
      })
    } else if (ss.type === 'file') {
      const data = fs.readFileSync(ss.path).toString('base64')
      userContent.push({
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${data}`, detail: 'low' },
      })
    }
  }

  const response = await client.chat.completions.create({
    model: evalModel,
    messages: [
      { role: 'system', content: EVAL_SYSTEM },
      { role: 'user', content: userContent },
    ],
    temperature: 0,
    response_format: { type: 'json_object' },
    max_tokens: 500,
  })

  const text = response.choices[0]?.message?.content || '{}'
  try {
    return JSON.parse(text)
  } catch {
    return { reasoning: text, result: 'ERROR' }
  }
}

// ── Run evaluation ──────────────────────────────────────────────────────────

async function runPool(items, fn, poolSize) {
  const results = []
  let idx = 0
  async function worker() {
    while (idx < items.length) {
      const i = idx++
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(poolSize, items.length) }, worker))
  return results
}

async function main() {
  const trajectories = trackSummary.results
    .map(extractTrajectory)
    .filter(Boolean)

  console.log(`Extracted ${trajectories.length} trajectories`)

  const withScreenshots = trajectories.filter((t) => t.screenshots.length > 0)
  const withoutScreenshots = trajectories.filter((t) => t.screenshots.length === 0)

  console.log(`  With screenshots: ${withScreenshots.length}`)
  console.log(`  Without screenshots (text-only eval): ${withoutScreenshots.length}`)

  if (dryRun) {
    console.log('\n[DRY RUN] Would evaluate:')
    for (const t of trajectories) {
      console.log(`  ${t.scenarioId}: ${t.screenshots.length} screenshots, agent=${t.agentPassed ? 'PASS' : 'FAIL'}`)
    }
    return
  }

  // Run LLM judge
  console.log(`\nEvaluating with ${evalModel} (concurrency=${concurrency})...`)

  const evalResults = await runPool(trajectories, async (t, i) => {
    const label = `[${i + 1}/${trajectories.length}] ${t.scenarioId}`
    try {
      const judgment = await judgeTask(t)
      const result = judgment.result === 'SUCCESS' ? 'SUCCESS' : 'NOT SUCCESS'
      const agree = (result === 'SUCCESS') === t.agentPassed
      console.log(`  ${label}: judge=${result} agent=${t.agentPassed ? 'PASS' : 'FAIL'} ${agree ? '' : '← DISAGREE'}`)
      return {
        scenarioId: t.scenarioId,
        goal: t.goal,
        agentAnswer: t.agentAnswer,
        agentPassed: t.agentPassed,
        judgeResult: result,
        judgeReasoning: judgment.reasoning,
        agree,
        turns: t.turns,
        screenshotCount: t.screenshots.length,
      }
    } catch (err) {
      console.error(`  ${label}: ERROR — ${err.message}`)
      return {
        scenarioId: t.scenarioId,
        goal: t.goal,
        agentPassed: t.agentPassed,
        judgeResult: 'ERROR',
        judgeReasoning: err.message,
        agree: false,
        turns: t.turns,
        screenshotCount: t.screenshots.length,
      }
    }
  }, concurrency)

  // Aggregate
  const total = evalResults.length
  const judgePass = evalResults.filter((r) => r.judgeResult === 'SUCCESS').length
  const agentPass = evalResults.filter((r) => r.agentPassed).length
  const agree = evalResults.filter((r) => r.agree).length
  const errors = evalResults.filter((r) => r.judgeResult === 'ERROR').length

  const summary = {
    benchmark: 'webvoyager',
    evalModel,
    generatedAt: new Date().toISOString(),
    resultsDir,
    total,
    judgePassRate: judgePass / total,
    agentPassRate: agentPass / total,
    agreementRate: agree / total,
    errors,
    bySite: {},
    results: evalResults,
  }

  // Per-site breakdown
  for (const r of evalResults) {
    const site = r.scenarioId.replace(/^wv-/, '').split('--')[0]
    if (!summary.bySite[site]) summary.bySite[site] = { total: 0, judgePass: 0, agentPass: 0 }
    summary.bySite[site].total++
    if (r.judgeResult === 'SUCCESS') summary.bySite[site].judgePass++
    if (r.agentPassed) summary.bySite[site].agentPass++
  }

  fs.writeFileSync(outFile, JSON.stringify(summary, null, 2) + '\n')

  console.log('\n═══════════════════════════════════════')
  console.log(`WebVoyager Evaluation — ${evalModel}`)
  console.log('═══════════════════════════════════════')
  console.log(`Total tasks:       ${total}`)
  console.log(`Judge pass rate:   ${(summary.judgePassRate * 100).toFixed(1)}%  (${judgePass}/${total})`)
  console.log(`Agent pass rate:   ${(summary.agentPassRate * 100).toFixed(1)}%  (${agentPass}/${total})`)
  console.log(`Agreement:         ${(summary.agreementRate * 100).toFixed(1)}%  (${agree}/${total})`)
  if (errors) console.log(`Errors:            ${errors}`)
  console.log('\nPer site:')
  for (const [site, s] of Object.entries(summary.bySite).sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${site.padEnd(20)} ${s.judgePass}/${s.total} (${((s.judgePass / s.total) * 100).toFixed(0)}%)`)
  }
  console.log(`\nFull results: ${outFile}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
