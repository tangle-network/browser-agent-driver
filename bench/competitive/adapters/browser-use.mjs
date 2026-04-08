/**
 * browser-use adapter — STUB.
 *
 * Detection works (it scans for a browser-use CLI on PATH or a venv at
 * .venv-browseruse). The runTask path is intentionally a NotImplemented
 * stub for now: shipping a Python child-process bridge introduces a
 * second runtime + auth surface that the user has to install before they
 * can run the comparison. We don't bake those install steps into this
 * repo. The stub returns a clean failure with `errorReason` so the
 * runner reports the cell as skipped instead of crashing.
 *
 * To finish this adapter:
 *   1. pip install browser-use playwright (per docs/COMPETITIVE-EVAL.md)
 *   2. Implement bench/competitive/adapters/_browser_use_runner.py that
 *      takes (goal, url, model, output_dir) on the CLI and writes a
 *      result.json with: success, wallTimeMs, turnCount, llmCallCount,
 *      inputTokens, outputTokens, costUsd, finalUrl, finalSnapshot,
 *      resultText.
 *   3. Replace the runTask body to spawn the python script and
 *      read result.json.
 */

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

export const FRAMEWORK_ID = 'browser-use'

export function detect(repoRoot) {
  // Check for a venv next to the repo
  const venvPaths = [
    path.join(repoRoot, '.venv-browseruse', 'bin', 'python'),
    path.join(repoRoot, '..', '.venv-browseruse', 'bin', 'python'),
  ]
  for (const p of venvPaths) {
    if (fs.existsSync(p)) {
      return { available: true, version: tryGetVersion(p), pythonPath: p }
    }
  }

  // Check for browser-use on PATH
  try {
    const out = execSync('python3 -c "import browser_use; print(browser_use.__version__)"', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return { available: true, version: String(out).trim(), pythonPath: 'python3' }
  } catch {
    return {
      available: false,
      reason: 'browser-use not installed. See docs/COMPETITIVE-EVAL.md → Install section',
    }
  }
}

function tryGetVersion(pythonPath) {
  try {
    const out = execSync(`${pythonPath} -c "import browser_use; print(browser_use.__version__)"`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return String(out).trim()
  } catch {
    return 'unknown'
  }
}

export async function runTask(task, options) {
  // The python bridge lives at bench/competitive/adapters/_browser_use_runner.py
  // and is not yet implemented. Return a clean failure record so the runner
  // reports the cell honestly rather than crashing.
  const startedAt = Date.now()
  return {
    framework: 'browser-use',
    frameworkVersion: detect(options.repoRoot).version ?? 'not-installed',
    taskId: task.id,
    runId: options.runId ?? `browser-use-${task.id}-${startedAt}`,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    success: false,
    oracleVerdict: { passed: false, reason: 'browser-use adapter stub: runner not yet implemented', detail: 'see docs/COMPETITIVE-EVAL.md' },
    agentClaimedSuccess: false,
    wallTimeMs: 0,
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
    rawArtifactDir: options.outDir,
    errorReason: 'adapter not yet implemented (stub)',
    exitCode: -1,
  }
}
