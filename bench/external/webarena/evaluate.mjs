#!/usr/bin/env node

/**
 * WebArena evaluation harness — programmatic evaluation using WebArena's
 * string_match, url_match, and program_html evaluators.
 *
 * Usage:
 *   node bench/external/webarena/evaluate.mjs --results ./agent-results/wa-xxx --cases bench/external/webarena/cases.json
 */

import fs from 'node:fs'
import path from 'node:path'

const __dir = path.dirname(new URL(import.meta.url).pathname)
const argv = process.argv.slice(2)

const getArg = (name, fallback) => {
  const idx = argv.indexOf(`--${name}`)
  if (idx === -1) return fallback
  return argv[idx + 1]
}

const resultsDir = path.resolve(getArg('results', ''))
const casesFile = path.resolve(getArg('cases', path.join(__dir, 'cases.json')))
const outFile = getArg('out', path.join(resultsDir, 'wa-eval.json'))

if (!resultsDir || !fs.existsSync(resultsDir)) {
  console.error('Usage: node evaluate.mjs --results <dir> [--cases <cases.json>]')
  process.exit(1)
}

// ── Load data ───────────────────────────────────────────────────────────────

const trackSummary = JSON.parse(fs.readFileSync(path.join(resultsDir, 'track-summary.json'), 'utf8'))
const cases = JSON.parse(fs.readFileSync(casesFile, 'utf8'))
const caseMap = new Map(cases.map((c) => [c.id, c]))

console.log(`Loaded ${trackSummary.results.length} results, ${cases.length} cases`)

// ── Evaluators ──────────────────────────────────────────────────────────────

function evalStringMatch(agentAnswer, referenceAnswers) {
  if (!agentAnswer || !referenceAnswers) return false
  const answer = agentAnswer.toLowerCase()

  // must_include: all strings must appear
  if (referenceAnswers.must_include) {
    for (const s of referenceAnswers.must_include) {
      if (!answer.includes(s.toLowerCase())) return false
    }
  }

  // must_exclude: none should appear
  if (referenceAnswers.must_exclude) {
    for (const s of referenceAnswers.must_exclude) {
      if (answer.includes(s.toLowerCase())) return false
    }
  }

  // exact_match: if present, must match exactly
  if (referenceAnswers.exact_match !== undefined) {
    if (answer.trim() !== String(referenceAnswers.exact_match).toLowerCase().trim()) return false
  }

  return true
}

function evalUrlMatch(finalUrl, referenceUrl) {
  if (!referenceUrl || !finalUrl) return false
  // Normalize trailing slashes and compare
  const normalize = (u) => u.replace(/\/+$/, '').toLowerCase()
  return normalize(finalUrl) === normalize(referenceUrl)
}

function evalProgramHtml(/* pageHtml, programs */) {
  // program_html evaluation requires running Python code against the page HTML.
  // For now, skip — these need the WebArena Python evaluator or a port.
  return null // null = unevaluated
}

// ── Evaluate each result ────────────────────────────────────────────────────

const evalResults = []

for (const result of trackSummary.results) {
  const caseConfig = caseMap.get(result.scenarioId)
  if (!caseConfig?._wa?.eval) {
    evalResults.push({
      scenarioId: result.scenarioId,
      evalResult: 'SKIP',
      reason: 'No eval config',
    })
    continue
  }

  const evalConfig = caseConfig._wa.eval
  const summary = result.summary
  const run = summary?.runs?.find((r) => r.mode === 'fast-explore') || summary?.runs?.[0]

  // Extract agent answer and final URL
  let agentAnswer = ''
  let finalUrl = ''

  if (run?.reportPath && fs.existsSync(run.reportPath)) {
    const report = JSON.parse(fs.readFileSync(run.reportPath, 'utf8'))
    const testResult = report.results?.[0]
    agentAnswer = testResult?.agentResult?.result || ''
    // Get final URL from last turn
    const turns = testResult?.agentResult?.turns || []
    if (turns.length > 0) {
      finalUrl = turns[turns.length - 1]?.state?.url || ''
    }
  }

  let passed = false
  let evalDetails = {}

  for (const evalType of evalConfig.eval_types || []) {
    switch (evalType) {
      case 'string_match':
        passed = evalStringMatch(agentAnswer, evalConfig.reference_answers)
        evalDetails.string_match = passed
        break
      case 'url_match':
        passed = evalUrlMatch(finalUrl, evalConfig.reference_url)
        evalDetails.url_match = passed
        break
      case 'program_html': {
        const result = evalProgramHtml()
        evalDetails.program_html = result
        if (result === null) {
          // Can't evaluate — fall back to agent's own verdict
          evalDetails.fallback = 'agent_verdict'
        }
        break
      }
    }
  }

  evalResults.push({
    scenarioId: result.scenarioId,
    goal: caseConfig.goal,
    agentAnswer: agentAnswer.slice(0, 500),
    finalUrl,
    evalTypes: evalConfig.eval_types,
    evalDetails,
    evalResult: passed ? 'PASS' : 'FAIL',
    agentVerdict: run?.metrics?.passed ? 'PASS' : 'FAIL',
  })
}

// ── Aggregate ───────────────────────────────────────────────────────────────

const total = evalResults.filter((r) => r.evalResult !== 'SKIP').length
const passed = evalResults.filter((r) => r.evalResult === 'PASS').length
const agentPassed = evalResults.filter((r) => r.agentVerdict === 'PASS').length
const unevaluated = evalResults.filter(
  (r) => r.evalDetails?.program_html === null && r.evalDetails?.fallback,
).length

const summary = {
  benchmark: 'webarena',
  generatedAt: new Date().toISOString(),
  resultsDir,
  total,
  passed,
  passRate: total > 0 ? passed / total : 0,
  agentPassRate: total > 0 ? agentPassed / total : 0,
  unevaluated,
  bySite: {},
  byEvalType: {},
  results: evalResults,
}

// Per-site
for (const r of evalResults) {
  const site = r.scenarioId.replace(/^wa-/, '').split('-')[0] || 'unknown'
  if (!summary.bySite[site]) summary.bySite[site] = { total: 0, passed: 0 }
  summary.bySite[site].total++
  if (r.evalResult === 'PASS') summary.bySite[site].passed++
}

// Per-eval-type
for (const r of evalResults) {
  for (const et of r.evalTypes || []) {
    if (!summary.byEvalType[et]) summary.byEvalType[et] = { total: 0, passed: 0 }
    summary.byEvalType[et].total++
    if (r.evalDetails?.[et]) summary.byEvalType[et].passed++
  }
}

fs.writeFileSync(outFile, JSON.stringify(summary, null, 2) + '\n')

console.log('\n═══════════════════════════════════════')
console.log('WebArena Evaluation')
console.log('═══════════════════════════════════════')
console.log(`Total evaluated:   ${total}`)
console.log(`Pass rate:         ${(summary.passRate * 100).toFixed(1)}%  (${passed}/${total})`)
console.log(`Agent verdict:     ${(summary.agentPassRate * 100).toFixed(1)}%  (${agentPassed}/${total})`)
if (unevaluated) console.log(`Unevaluated (program_html): ${unevaluated}`)
console.log(`\nFull results: ${outFile}`)
