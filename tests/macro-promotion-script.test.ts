/**
 * End-to-end coverage for scripts/run-macro-promotion.mjs.
 *
 * Rather than spawn a real multi-rep (which needs an LLM key and a browser),
 * we stub the `run-multi-rep.mjs` child process with a shell wrapper that
 * writes canned multi-rep-summary.json files. That exercises the real
 * orchestration path: subprocess spawn, tmpdir staging, BAD_MACROS_DIR
 * env propagation, summary JSON parsing, rejected-report writing,
 * experiments.jsonl append, file moves on promote.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const promotionScript = path.join(repoRoot, 'scripts', 'run-macro-promotion.mjs')

function writeStubMultiRep(tmpDir: string): string {
  // Write a fake run-multi-rep.mjs that reads the --label flag, synthesizes a
  // canned multi-rep-summary.json that varies by label (treatment faster
  // than baseline), writes it into the --out dir, and exits 0.
  const stubPath = path.join(tmpDir, 'scripts', 'run-multi-rep.mjs')
  fs.mkdirSync(path.dirname(stubPath), { recursive: true })
  fs.writeFileSync(stubPath, `#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
const argv = process.argv.slice(2)
const getArg = (n) => { const i = argv.indexOf('--' + n); return i === -1 ? null : argv[i+1] }
const label = getArg('label') || 'unknown'
const outDir = getArg('out')
const reps = parseInt(getArg('reps') || '3', 10)
fs.mkdirSync(outDir, { recursive: true })
const turnsMean = label.includes('treatment') ? 4 : 7
const summary = {
  generatedAt: new Date().toISOString(),
  label,
  reps,
  modes: ['fast-explore'],
  perModeStats: {
    'fast-explore': {
      reps,
      passRate: 1.0,
      turnsUsed: { n: reps, mean: turnsMean, min: turnsMean, max: turnsMean },
      costUsd: { n: reps, mean: 0.01, min: 0.01, max: 0.01 },
      durationMs: { n: reps, mean: 10000, min: 10000, max: 10000 },
      tokensUsed: { n: reps, mean: 0, min: 0, max: 0 },
      rawRuns: [],
    },
  },
  rigorWarnings: [],
}
fs.writeFileSync(path.join(outDir, 'multi-rep-summary.json'), JSON.stringify(summary, null, 2))
process.exit(0)
`, { mode: 0o755 })
  return stubPath
}

/** Minimal working repo layout that the promotion script can run against. */
function seedWorktree(tmp: string) {
  fs.mkdirSync(path.join(tmp, 'scripts', 'lib'), { recursive: true })
  fs.mkdirSync(path.join(tmp, '.evolve', 'candidates', 'macros'), { recursive: true })
  fs.mkdirSync(path.join(tmp, '.evolve', 'candidates', 'rejected'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'skills', 'macros'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'bench', 'scenarios', 'cases'), { recursive: true })
  // Copy the real promotion script + lib helper into the fake repo so
  // `rootDir` resolution inside the script picks up this tmp tree.
  fs.cpSync(promotionScript, path.join(tmp, 'scripts', 'run-macro-promotion.mjs'))
  fs.cpSync(
    path.join(repoRoot, 'scripts', 'lib', 'macro-promotion.mjs'),
    path.join(tmp, 'scripts', 'lib', 'macro-promotion.mjs'),
  )
  // A dummy bench case the candidate's `benchCase` can point at. Content
  // doesn't matter for the stubbed multi-rep.
  fs.writeFileSync(path.join(tmp, 'bench', 'scenarios', 'cases', 'fake.json'), JSON.stringify([
    { id: 'fake', name: 'fake', startUrl: 'about:blank', goal: 'fake', maxTurns: 5 },
  ]))
}

function writeCandidate(tmp: string, macroName: string, extras: Record<string, unknown> = {}) {
  const p = path.join(tmp, '.evolve', 'candidates', 'macros', `${macroName}.json`)
  fs.writeFileSync(p, JSON.stringify({
    macro: {
      name: macroName,
      description: 'test macro',
      params: [],
      steps: [{ action: 'wait', ms: 10 }],
      ...((extras.macro as object) ?? {}),
    },
    eval: {
      benchCase: 'bench/scenarios/cases/fake.json',
      reps: 3,
      successCriteria: { minPassRate: 1.0 },
      ...((extras.eval as object) ?? {}),
    },
    rationale: 'testing',
  }, null, 2))
  return p
}

describe('run-macro-promotion.mjs — end-to-end against stubbed multi-rep', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-promo-e2e-'))
    seedWorktree(tmp)
    writeStubMultiRep(tmp)
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('promote path: moves macro JSON into skills/macros/ and appends experiments.jsonl', () => {
    writeCandidate(tmp, 'winner')
    const result = spawnSync('node', [
      path.join(tmp, 'scripts', 'run-macro-promotion.mjs'),
      '--candidate', path.join(tmp, '.evolve', 'candidates', 'macros', 'winner.json'),
      '--auto-promote',
    ], { cwd: tmp, encoding: 'utf-8' })
    expect(result.status).toBe(0)
    const promoted = path.join(tmp, 'skills', 'macros', 'winner.json')
    expect(fs.existsSync(promoted)).toBe(true)
    const loaded = JSON.parse(fs.readFileSync(promoted, 'utf-8'))
    expect(loaded.name).toBe('winner')
    // candidate removed
    expect(fs.existsSync(path.join(tmp, '.evolve', 'candidates', 'macros', 'winner.json'))).toBe(false)
    // experiments log appended
    const log = fs.readFileSync(path.join(tmp, '.evolve', 'experiments.jsonl'), 'utf-8').trim().split('\n')
    expect(log).toHaveLength(1)
    const entry = JSON.parse(log[0])
    expect(entry.event).toBe('macro-promoted')
    expect(entry.name).toBe('winner')
  })

  it('reject path: writes rejected report and keeps candidate when --auto-promote off', () => {
    // Force reject by setting an unattainable passRate criterion
    writeCandidate(tmp, 'tight', { eval: { successCriteria: { minPassRate: 1.5 } } })
    const result = spawnSync('node', [
      path.join(tmp, 'scripts', 'run-macro-promotion.mjs'),
      '--candidate', path.join(tmp, '.evolve', 'candidates', 'macros', 'tight.json'),
    ], { cwd: tmp, encoding: 'utf-8' })
    expect(result.status).toBe(0)
    // No promotion because --auto-promote wasn't passed
    expect(fs.existsSync(path.join(tmp, 'skills', 'macros', 'tight.json'))).toBe(false)
    // Rejected report exists
    const rejectedDir = path.join(tmp, '.evolve', 'candidates', 'rejected')
    const rejected = fs.readdirSync(rejectedDir).filter((f) => f.startsWith('tight-'))
    expect(rejected).toHaveLength(1)
    const body = fs.readFileSync(path.join(rejectedDir, rejected[0]), 'utf-8')
    expect(body).toContain('Verdict: **reject**')
    expect(body).toContain('Rationale (from candidate)')
  })

  it('rejects candidate with path-traversing macro name before any file write', () => {
    // Hand-write the candidate to bypass validateMacroDefinition's regex check
    const badPath = path.join(tmp, '.evolve', 'candidates', 'macros', 'evil.json')
    fs.writeFileSync(badPath, JSON.stringify({
      macro: {
        name: '../../etc/passwd',
        description: 'x',
        params: [],
        steps: [{ action: 'wait', ms: 1 }],
      },
      eval: { benchCase: 'bench/scenarios/cases/fake.json', reps: 3 },
    }, null, 2))
    const result = spawnSync('node', [
      path.join(tmp, 'scripts', 'run-macro-promotion.mjs'),
      '--candidate', badPath,
      '--auto-promote',
    ], { cwd: tmp, encoding: 'utf-8' })
    // Script exits 0 but logs FAILED for this candidate; no file clobbered
    const stdoutAll = (result.stdout || '') + '\n' + (result.stderr || '')
    expect(stdoutAll).toMatch(/FAILED:.*macro\.name must match/)
    expect(fs.existsSync(path.join(tmp, 'skills', 'macros', '../../etc/passwd.json'))).toBe(false)
  })
})
