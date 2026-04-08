/**
 * `bad` adapter for the competitive bench harness.
 *
 * Spawns a single-task run via `scripts/run-mode-baseline.mjs`, parses the
 * suite report.json, reads the final ARIA snapshot from events.jsonl, and
 * runs the task's external oracle. Returns a CompetitiveRunResult that
 * matches what every other adapter must produce.
 *
 * Why we don't trust `agentSuccess` directly: each framework has its own
 * notion of success. A fair head-to-head needs an EXTERNAL oracle that
 * checks the same observable state regardless of which framework ran.
 * `bad`'s `agentSuccess` is reported alongside but is not the verdict.
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { evaluateOracle } from './_oracle.mjs'

export const FRAMEWORK_ID = 'bad'

/**
 * Anti-bot / unreachable-site detection. When a real-web task hits cloudflare,
 * recaptcha, "Verifying you are human", or chrome-error://, this is NOT a
 * `bad` failure — it's the site refusing the bot. Mark it as `blocked` so
 * the gauntlet reports it separately from genuine architectural failures.
 *
 * Returns null if not blocked, otherwise a string reason.
 */
export function detectAntiBotBlock(finalState, runResult) {
  const url = String(finalState?.finalUrl ?? '')
  const snapshot = String(finalState?.finalSnapshot ?? '').toLowerCase()
  const result = String(finalState?.resultText ?? '').toLowerCase()
  const verdict = String(runResult?.verdict ?? '').toLowerCase()

  // Chrome navigation error (DNS, refused, cert, blocked)
  if (url.startsWith('chrome-error://') || verdict.includes('chrome-error')) {
    return 'chrome-error: site unreachable from this browser environment'
  }
  // Cloudflare interstitial
  const cloudflareMarkers = [
    'just a moment...',
    'verifying you are human',
    'checking your browser before',
    'cloudflare ray id',
    '__cf_chl_',
    'cf-chl-',
    'cf-mitigated',
  ]
  for (const m of cloudflareMarkers) {
    if (snapshot.includes(m) || result.includes(m)) {
      return `cloudflare interstitial: "${m}"`
    }
  }
  // Recaptcha / hCaptcha
  if (snapshot.includes('recaptcha') || snapshot.includes('hcaptcha') || snapshot.includes('please complete the captcha')) {
    return 'captcha challenge'
  }
  // 403 / 429 / Access Denied banners
  if (snapshot.includes('access denied') || snapshot.includes('403 forbidden') || snapshot.includes('429 too many requests')) {
    return 'site returned access-denied banner'
  }
  // Bot-detection vendors
  if (snapshot.includes('please enable javascript and cookies to continue') || snapshot.includes('akamai') || snapshot.includes('perimeterx')) {
    return 'bot-detection vendor block'
  }
  return null
}

/**
 * Detect whether the framework is available. For `bad` this is just
 * checking that dist/cli.js was built; we live in the same repo.
 */
export function detect(repoRoot) {
  const cliPath = path.join(repoRoot, 'dist', 'cli.js')
  if (!fs.existsSync(cliPath)) {
    return { available: false, reason: 'dist/cli.js not found — run `pnpm build`' }
  }
  return { available: true, version: readVersion(repoRoot) }
}

function readVersion(repoRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'))
    return pkg.version
  } catch {
    return 'unknown'
  }
}

/**
 * Run a single task once.
 *
 * @param {object} task - parsed task JSON from bench/competitive/tasks/
 * @param {object} options
 * @param {string} options.repoRoot - absolute path to repo root
 * @param {string} options.outDir - absolute path where this run's artifacts live
 * @param {string} [options.fixtureBaseUrl] - http://127.0.0.1:NNNN base for __FIXTURE_BASE_URL__
 * @param {string} [options.model] - model id (default gpt-5.2)
 * @param {string} [options.config] - absolute path to a bad config file
 * @param {string} [options.runId] - stable run id for the artifact dir
 * @returns {Promise<CompetitiveRunResult>}
 */
export async function runTask(task, options) {
  const startedAt = Date.now()
  const runId = options.runId ?? `bad-${task.id}-${startedAt}`
  const runDir = path.join(options.outDir, runId)
  fs.mkdirSync(runDir, { recursive: true })

  const startUrl = String(task.startUrl ?? '').replace(
    '__FIXTURE_BASE_URL__',
    options.fixtureBaseUrl ?? '__FIXTURE_BASE_URL__',
  )
  if (startUrl.includes('__FIXTURE_BASE_URL__')) {
    return failureResult(runId, runDir, startedAt, task, 'task uses __FIXTURE_BASE_URL__ but no fixture server provided')
  }

  const args = [
    'scripts/run-mode-baseline.mjs',
    '--goal', task.goal,
    '--url', startUrl,
    '--max-turns', String(task.maxTurns ?? 30),
    '--timeout-ms', String(task.timeoutMs ?? 600000),
    '--out', runDir,
    '--modes', 'fast-explore',
    '--model', options.model ?? 'gpt-5.2',
    '--memory-isolation', 'per-run',
    '--memory-scope-id', runId,
  ]
  if (options.config) args.push('--config', path.resolve(options.config))

  const exitCode = await new Promise((resolve) => {
    const proc = spawn('node', args, {
      cwd: options.repoRoot,
      env: process.env,
      stdio: 'inherit',
    })
    proc.on('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1)))
    proc.on('error', () => resolve(1))
  })

  const reportPath = path.join(runDir, 'fast-explore', 'suite', 'report.json')
  if (!fs.existsSync(reportPath)) {
    return failureResult(runId, runDir, startedAt, task, `no suite report.json (exit ${exitCode})`)
  }
  let report
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'))
  } catch (err) {
    return failureResult(runId, runDir, startedAt, task, `report.json parse error: ${err instanceof Error ? err.message : String(err)}`)
  }
  const result = report.results?.[0]
  if (!result) {
    return failureResult(runId, runDir, startedAt, task, 'report.json has no results[0]')
  }

  // Read the last observe-completed event for the final page state, and
  // aggregate per-call token counters from decide-completed/plan-completed
  // events. The agent's per-run summary in report.json does NOT carry the
  // cacheReadInputTokens aggregate, so we sum it from events here.
  const eventsPath = path.join(runDir, 'fast-explore', 'cli-task', 'events.jsonl')
  const finalState = readFinalState(eventsPath, result)
  const eventTotals = aggregateLlmEvents(eventsPath)

  // Anti-bot detection: if the site refused us, mark `blocked` so the
  // gauntlet reports it separately from architectural failures.
  const blockReason = detectAntiBotBlock(finalState, result)
  const oracleVerdict = blockReason
    ? { passed: false, reason: 'blocked by site (anti-bot / unreachable)', detail: blockReason }
    : evaluateOracle(task.oracle, finalState)

  return {
    framework: 'bad',
    frameworkVersion: readVersion(options.repoRoot),
    taskId: task.id,
    runId,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    success: oracleVerdict.passed,
    blocked: !!blockReason,
    blockReason,
    oracleVerdict,
    agentClaimedSuccess: result.agentSuccess === true,
    wallTimeMs: typeof result.durationMs === 'number' ? result.durationMs : Date.now() - startedAt,
    turnCount: typeof result.turnsUsed === 'number' ? result.turnsUsed : null,
    llmCallCount: eventTotals.llmCallCount,
    inputTokens: typeof result.inputTokens === 'number' ? result.inputTokens : null,
    outputTokens: typeof result.outputTokens === 'number' ? result.outputTokens : null,
    cachedInputTokens: eventTotals.cacheReadInputTokens,
    totalTokens: typeof result.tokensUsed === 'number' ? result.tokensUsed : null,
    costUsd: typeof result.estimatedCostUsd === 'number' ? result.estimatedCostUsd : null,
    finalUrl: finalState.finalUrl,
    finalTitle: finalState.finalTitle,
    resultText: finalState.resultText,
    rawArtifactDir: runDir,
    errorReason: oracleVerdict.passed ? null : (blockReason ?? oracleVerdict.reason),
    exitCode,
  }
}

function failureResult(runId, runDir, startedAt, task, reason) {
  return {
    framework: 'bad',
    frameworkVersion: readVersion(path.dirname(path.dirname(runDir))) || 'unknown',
    taskId: task.id,
    runId,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    success: false,
    oracleVerdict: { passed: false, reason, detail: '' },
    agentClaimedSuccess: false,
    wallTimeMs: Date.now() - startedAt,
    turnCount: null,
    llmCallCount: 0,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: 0,
    totalTokens: null,
    costUsd: null,
    finalUrl: '',
    finalTitle: '',
    resultText: '',
    rawArtifactDir: runDir,
    errorReason: reason,
    exitCode: -1,
  }
}

function readFinalState(eventsPath, result) {
  const finalState = {
    finalUrl: '',
    finalTitle: '',
    finalSnapshot: '',
    resultText: result.agentResult?.result ?? result.verdict ?? '',
  }
  if (!fs.existsSync(eventsPath)) return finalState

  const lines = fs.readFileSync(eventsPath, 'utf-8').split('\n').filter(Boolean)
  // Walk backwards to find the last observe-completed event with a snapshot.
  for (let i = lines.length - 1; i >= 0; i--) {
    let event
    try { event = JSON.parse(lines[i]) } catch { continue }
    if (event.type === 'observe-completed') {
      if (event.url) finalState.finalUrl = event.url
      if (event.title) finalState.finalTitle = event.title
      if (typeof event.snapshot === 'string') {
        finalState.finalSnapshot = event.snapshot
        break
      }
    }
  }
  return finalState
}

/**
 * Walk events.jsonl and tally per-LLM-call counters that the agent's
 * suite report.json doesn't aggregate. Specifically:
 *   - llmCallCount: count of decide-completed + plan-completed events
 *   - cacheReadInputTokens: sum across all LLM events
 *
 * The agent's run-level summary tallies inputTokens / outputTokens / cost
 * but skips cacheReadInputTokens. We need it here for the cache-hit
 * rate report in the competitive comparison.
 */
function aggregateLlmEvents(eventsPath) {
  const totals = { llmCallCount: 0, cacheReadInputTokens: 0 }
  if (!fs.existsSync(eventsPath)) return totals
  const lines = fs.readFileSync(eventsPath, 'utf-8').split('\n').filter(Boolean)
  for (const line of lines) {
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === 'decide-completed' || event.type === 'plan-completed') {
      totals.llmCallCount++
      if (typeof event.cacheReadInputTokens === 'number') {
        totals.cacheReadInputTokens += event.cacheReadInputTokens
      }
    }
  }
  return totals
}
