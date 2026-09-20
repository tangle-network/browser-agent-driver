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
