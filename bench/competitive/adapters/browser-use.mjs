/**
 * browser-use adapter for the competitive bench harness.
 *
 * Spawns the Python bridge at bench/competitive/adapters/_browser_use_runner.py
 * via the venv at .venv-browseruse (or whatever Python has browser-use
 * importable on PATH). The bridge runs a browser_use.Agent against the task
 * URL, captures token usage by monkey-patching ChatOpenAI.ainvoke, and writes
 * result.json. We parse result.json, run the same external oracle every
 * other adapter uses, and return the canonical CompetitiveRunResult.
 *
 * Cost estimation: browser-use 0.12.x doesn't ship a billing module; we use
 * the same OpenAI per-token rates the bad adapter uses (gpt-5.2 input/cached/
 * output prices) so the cross-framework cost comparison is fair.
 */

import fs from 'node:fs'
import path from 'node:path'
import { execSync, spawn } from 'node:child_process'
import { evaluateOracle } from './_oracle.mjs'

export const FRAMEWORK_ID = 'browser-use'

// Per-token pricing for cost computation. These match the bad adapter's
// pricing so the comparison is fair. Update when OpenAI changes prices.
const PRICING = {
  'gpt-5.2': { input: 2.5e-6, cachedInput: 0.25e-6, output: 10e-6 },
  'gpt-5.1': { input: 2.5e-6, cachedInput: 0.25e-6, output: 10e-6 },
  'gpt-5':   { input: 2.5e-6, cachedInput: 0.25e-6, output: 10e-6 },
  'gpt-4o':  { input: 2.5e-6, cachedInput: 1.25e-6, output: 10e-6 },
  'gpt-4o-mini': { input: 0.15e-6, cachedInput: 0.075e-6, output: 0.6e-6 },
}

function priceFor(model) {
  return PRICING[model] ?? PRICING['gpt-5.2']
}

function computeCost(model, inputTokens, cachedTokens, outputTokens) {
  const p = priceFor(model)
  const uncachedInput = Math.max(0, (inputTokens ?? 0) - (cachedTokens ?? 0))
  return uncachedInput * p.input + (cachedTokens ?? 0) * p.cachedInput + (outputTokens ?? 0) * p.output
}

export function detect(repoRoot) {
  // Prefer the local venv (most reproducible).
  const venvPaths = [
    path.join(repoRoot, '.venv-browseruse', 'bin', 'python'),
    path.join(repoRoot, '..', '.venv-browseruse', 'bin', 'python'),
  ]
  for (const p of venvPaths) {
    if (fs.existsSync(p)) {
      const version = tryGetVersion(p)
      return version
        ? { available: true, version, pythonPath: p, source: 'venv' }
        : { available: false, reason: `venv at ${p} but browser-use not importable` }
    }
  }
  // Fallback: any python3 with browser-use installed.
  try {
    const version = tryGetVersion('python3')
    if (version) return { available: true, version, pythonPath: 'python3', source: 'system' }
  } catch {}
  return {
    available: false,
    reason: 'browser-use not installed. See docs/COMPETITIVE-EVAL.md → Install section',
  }
}

function tryGetVersion(pythonPath) {
  try {
    const out = execSync(
      `${pythonPath} -c "import importlib.metadata as md; print(md.version('browser-use'))"`,
      { stdio: ['ignore', 'pipe', 'ignore'] },
    )
    return String(out).trim()
  } catch {
    return null
  }
}

export async function runTask(task, options) {
  const startedAt = Date.now()
  const runId = options.runId ?? `browser-use-${task.id}-${startedAt}`
  const runDir = path.join(options.outDir, runId)
  fs.mkdirSync(runDir, { recursive: true })

  const det = detect(options.repoRoot)
  if (!det.available) {
    return failureResult(runId, runDir, startedAt, task, det.reason ?? 'browser-use not available')
  }

  const startUrl = String(task.startUrl ?? '').replace(
    '__FIXTURE_BASE_URL__',
    options.fixtureBaseUrl ?? '__FIXTURE_BASE_URL__',
  )
  if (startUrl.includes('__FIXTURE_BASE_URL__')) {
    return failureResult(runId, runDir, startedAt, task, 'task uses __FIXTURE_BASE_URL__ but no fixture server provided')
  }

  const bridgePath = path.join(
    options.repoRoot,
    'bench',
    'competitive',
    'adapters',
    '_browser_use_runner.py',
  )

  const args = [
    bridgePath,
    '--goal', task.goal,
    '--url', startUrl,
    '--model', options.model ?? 'gpt-5.2',
    '--output-dir', runDir,
    '--max-steps', String(task.maxTurns ?? 30),
    '--timeout-sec', String(Math.floor((task.timeoutMs ?? 600000) / 1000)),
  ]

  const exitCode = await new Promise((resolve) => {
    const proc = spawn(det.pythonPath, args, {
      cwd: options.repoRoot,
      env: process.env,
      stdio: 'inherit',
    })
    proc.on('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1)))
    proc.on('error', () => resolve(1))
  })

  const resultPath = path.join(runDir, 'result.json')
  if (!fs.existsSync(resultPath)) {
    return failureResult(runId, runDir, startedAt, task, `bridge produced no result.json (exit ${exitCode})`, det.version)
  }
  let bridgeResult
  try {
    bridgeResult = JSON.parse(fs.readFileSync(resultPath, 'utf-8'))
  } catch (err) {
    return failureResult(runId, runDir, startedAt, task, `result.json parse error: ${err instanceof Error ? err.message : String(err)}`, det.version)
  }

  const finalState = {
    finalUrl: bridgeResult.final_url ?? '',
    finalTitle: '',
    finalSnapshot: bridgeResult.final_snapshot ?? '',
    resultText: bridgeResult.result_text ?? '',
  }

  const oracleVerdict = evaluateOracle(task.oracle, finalState)

  const inputTokens = bridgeResult.input_tokens
  const outputTokens = bridgeResult.output_tokens
  const cachedInputTokens = bridgeResult.cached_input_tokens ?? 0
  const totalTokens = bridgeResult.total_tokens
  const costUsd = computeCost(options.model ?? 'gpt-5.2', inputTokens, cachedInputTokens, outputTokens)

  return {
    framework: 'browser-use',
    frameworkVersion: bridgeResult.framework_version ?? det.version,
    taskId: task.id,
    runId,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    success: oracleVerdict.passed,
    oracleVerdict,
    agentClaimedSuccess: bridgeResult.is_successful === true,
    wallTimeMs: typeof bridgeResult.wall_time_ms === 'number' ? bridgeResult.wall_time_ms : Date.now() - startedAt,
    turnCount: typeof bridgeResult.turn_count === 'number' ? bridgeResult.turn_count : null,
    llmCallCount: typeof bridgeResult.llm_call_count === 'number' ? bridgeResult.llm_call_count : null,
    inputTokens: typeof inputTokens === 'number' ? inputTokens : null,
    outputTokens: typeof outputTokens === 'number' ? outputTokens : null,
    cachedInputTokens,
    totalTokens: typeof totalTokens === 'number' ? totalTokens : null,
    costUsd: Number.isFinite(costUsd) ? costUsd : null,
    finalUrl: finalState.finalUrl,
    finalTitle: finalState.finalTitle,
    resultText: finalState.resultText,
    rawArtifactDir: runDir,
    errorReason: oracleVerdict.passed ? null : (bridgeResult.error_reason ?? oracleVerdict.reason),
    exitCode,
  }
}

function failureResult(runId, runDir, startedAt, task, reason, frameworkVersion) {
  return {
    framework: 'browser-use',
    frameworkVersion: frameworkVersion ?? 'unknown',
    taskId: task.id,
    runId,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    success: false,
    oracleVerdict: { passed: false, reason, detail: '' },
    agentClaimedSuccess: false,
    wallTimeMs: Date.now() - startedAt,
    turnCount: null,
    llmCallCount: null,
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
