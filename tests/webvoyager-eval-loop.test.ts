import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const script = resolve('bench/research/webvoyager-agent-eval-loop.mjs')
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

it('ingests track results with process outcomes and honest measurement provenance', () => {
  const directory = mkdtempSync(join(tmpdir(), 'webvoyager-eval-'))
  directories.push(directory)
  const summaryPath = join(directory, 'track-summary.json')
  const results = [
    { scenarioId: 'passed', exitCode: 0, metrics: { passed: true, estimatedCostUsd: 0.1, inputTokens: 80, outputTokens: 20 } },
    { scenarioId: 'task-failed', exitCode: 0, metrics: { passed: false, verdict: 'Could not complete the task', estimatedCostUsd: 0, inputTokens: 0, outputTokens: 0 } },
    { scenarioId: 'process-failed', exitCode: 1, metrics: {} },
    { scenarioId: 'unknown', exitCode: undefined, metrics: {} },
  ].map(({ scenarioId, exitCode, metrics }) => ({
    scenarioId,
    summary: { goal: 'Find the requested page', url: 'https://example.com', runs: [{ exitCode, metrics }] },
  }))
  writeFileSync(summaryPath, JSON.stringify({ generatedAt: '2026-09-20T00:00:00Z', results }))
  execFileSync(process.execPath, [script, 'ingest', '--variant-id', 'baseline', '--track-summary', summaryPath, '--state-dir', directory], {
    env: { ...process.env, OPENAI_API_KEY: '', TANGLE_ROUTER_USER_KEY: '' },
    stdio: 'pipe',
  })
  const records = readFileSync(join(directory, 'run-records.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  expect(records).toMatchObject([
    { scenarioId: 'passed', terminalOutcome: 'succeeded', costUsd: 0.1, costProvenance: { kind: 'estimated', usd: 0.1 }, tokenUsage: { input: 80, output: 20 }, outcome: { searchScore: 1 } },
    { scenarioId: 'task-failed', terminalOutcome: 'succeeded', costUsd: 0, costProvenance: { kind: 'estimated', usd: 0 }, tokenUsage: { input: 0, output: 0 }, outcome: { searchScore: 0 } },
    { scenarioId: 'process-failed', terminalOutcome: 'failed', costUsd: null, costProvenance: { kind: 'uncaptured', usd: null }, tokenUsage: { input: 0, output: 0, tokensKnown: false } },
    { scenarioId: 'unknown', terminalOutcome: 'unknown', costUsd: null, costProvenance: { kind: 'uncaptured', usd: null }, tokenUsage: { input: 0, output: 0, tokensKnown: false } },
  ])
  expect(records[0].tokenUsage).not.toHaveProperty('tokensKnown')
  expect(records[1].tokenUsage).not.toHaveProperty('tokensKnown')
  for (const record of records) expect(record).not.toHaveProperty('failureMode')
  const rows = readFileSync(join(directory, 'optimizer-rows.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  expect(rows[1].score.notes).toContain('verifier-false-positive-risk')
})

it('ranks scored variants through Eval and writes the observed evidence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'webvoyager-eval-'))
  directories.push(directory)
  const rows = ['baseline', 'candidate'].flatMap(variantId => ['one', 'two'].map(scenarioId => ({
    variantId,
    scenarioId,
    bundle: { id: variantId },
    score: { success: variantId === 'candidate' ? 1 : 0, costUsd: 0, wallSeconds: 1 },
  })))
  writeFileSync(join(directory, 'optimizer-rows.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'))
  execFileSync(process.execPath, [script, 'optimize', '--state-dir', directory], {
    env: { ...process.env, OPENAI_API_KEY: '', TANGLE_ROUTER_USER_KEY: '' },
  })
  const result = JSON.parse(readFileSync(join(directory, 'optimization-result.json'), 'utf8'))
  expect(result.selection).toMatchObject({ method: 'pairwise', recommendedVariantId: 'candidate' })
  expect(result.coverage).toMatchObject({ totalScenarios: 2, comparableScenarios: 2 })
  expect(result.selection.rankings).toHaveLength(2)
  expect(result.selection.rankings.every((rank: { mean: number; runs: number }) =>
    Number.isFinite(rank.mean) && rank.runs === 2)).toBe(true)
  expect(result.nextTacticalStep).toContain('holdout')
})

it('refuses to rank variants without a shared scenario', () => {
  const directory = mkdtempSync(join(tmpdir(), 'webvoyager-eval-'))
  directories.push(directory)
  const rows = ['baseline', 'candidate'].map(variantId => ({
    variantId, scenarioId: variantId, bundle: { id: variantId }, score: { success: 1 },
  }))
  writeFileSync(join(directory, 'optimizer-rows.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'))
  expect(() => execFileSync(process.execPath, [script, 'optimize', '--state-dir', directory], {
    encoding: 'utf8', stdio: 'pipe',
  })).toThrow('no overlapping scenarios across variants')
})
