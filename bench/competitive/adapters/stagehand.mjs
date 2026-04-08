/**
 * Stagehand adapter — STUB.
 *
 * Same shape as the browser-use stub. Detection works (looks for
 * @browserbasehq/stagehand on PATH or in node_modules), runTask is a
 * NotImplemented stub that returns a clean failure record.
 *
 * To finish this adapter:
 *   1. Install stagehand globally OR add as a side install (see
 *      docs/COMPETITIVE-EVAL.md → Install section)
 *   2. Set BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID
 *   3. Implement bench/competitive/adapters/_stagehand_runner.ts that
 *      takes (goal, url, model, output_dir) on argv and writes a
 *      result.json with the CompetitiveRunResult shape.
 *   4. Replace runTask body to spawn the TS runner via tsx.
 */

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

export const FRAMEWORK_ID = 'stagehand'

export function detect(repoRoot) {
  // Check repo node_modules first
  const localPkg = path.join(repoRoot, 'node_modules', '@browserbasehq', 'stagehand', 'package.json')
  if (fs.existsSync(localPkg)) {
    try {
      const v = JSON.parse(fs.readFileSync(localPkg, 'utf-8')).version
      return { available: true, version: v, source: 'node_modules' }
    } catch {}
  }

  // Try global pnpm
  try {
    const out = execSync('pnpm list -g @browserbasehq/stagehand --depth 0 2>/dev/null', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (String(out).includes('@browserbasehq/stagehand')) {
      return { available: true, version: 'global', source: 'pnpm-global' }
    }
  } catch {}

  return {
    available: false,
    reason: 'Stagehand not installed. See docs/COMPETITIVE-EVAL.md → Install section',
  }
}

export async function runTask(task, options) {
  const startedAt = Date.now()
  return {
    framework: 'stagehand',
    frameworkVersion: detect(options.repoRoot).version ?? 'not-installed',
    taskId: task.id,
    runId: options.runId ?? `stagehand-${task.id}-${startedAt}`,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    success: false,
    oracleVerdict: { passed: false, reason: 'Stagehand adapter stub: runner not yet implemented', detail: 'see docs/COMPETITIVE-EVAL.md' },
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
