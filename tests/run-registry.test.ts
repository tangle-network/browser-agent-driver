import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { RunRegistry } from '../src/memory/run-registry.js'
import type { RunManifest } from '../src/memory/run-registry.js'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('RunRegistry', () => {
  let dir: string
  let registry: RunRegistry

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'run-registry-test-'))
    registry = new RunRegistry(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('starts and retrieves a run', () => {
    const runId = registry.startRun({
      runId: 'run_001',
      goal: 'Build a todo app',
      domain: 'example.com',
      startUrl: 'https://example.com',
    })
    expect(runId).toBe('run_001')

    const manifest = registry.getRun('run_001')
    expect(manifest).toBeDefined()
    expect(manifest!.status).toBe('running')
    expect(manifest!.goal).toBe('Build a todo app')
    expect(manifest!.domain).toBe('example.com')
    expect(manifest!.turnCount).toBe(0)
    expect(manifest!.artifactPaths).toEqual([])
  })

  it('completes a run with results', () => {
    registry.startRun({
      runId: 'run_002',
      goal: 'Add auth',
      domain: 'example.com',
    })

    const manifest = registry.completeRun('run_002', {
      success: true,
      finalUrl: 'https://example.com/login',
      summary: 'Added email/password auth',
      result: 'Created login and signup pages',
      turnCount: 6,
    })

    expect(manifest!.status).toBe('completed')
    expect(manifest!.success).toBe(true)
    expect(manifest!.finalUrl).toBe('https://example.com/login')
    expect(manifest!.summary).toBe('Added email/password auth')
    expect(manifest!.turnCount).toBe(6)
    expect(manifest!.completedAt).toBeDefined()
  })

  it('marks failed runs', () => {
    registry.startRun({
      runId: 'run_003',
      goal: 'Deploy',
      domain: 'example.com',
    })

    const manifest = registry.completeRun('run_003', {
      success: false,
      reason: 'Build failed: missing dependency',
      turnCount: 3,
    })

    expect(manifest!.status).toBe('failed')
    expect(manifest!.success).toBe(false)
    expect(manifest!.reason).toBe('Build failed: missing dependency')
  })

  it('lists runs filtered by domain', () => {
    registry.startRun({ runId: 'r1', goal: 'G1', domain: 'a.com' })
    registry.startRun({ runId: 'r2', goal: 'G2', domain: 'b.com' })
    registry.startRun({ runId: 'r3', goal: 'G3', domain: 'a.com' })

    const aRuns = registry.listRuns({ domain: 'a.com' })
    expect(aRuns).toHaveLength(2)
    expect(aRuns.every(r => r.domain === 'a.com')).toBe(true)
  })

  it('lists runs filtered by sessionId', () => {
    registry.startRun({ runId: 'r1', sessionId: 'proj_1', goal: 'G1', domain: 'a.com' })
    registry.startRun({ runId: 'r2', sessionId: 'proj_2', goal: 'G2', domain: 'a.com' })
    registry.startRun({ runId: 'r3', sessionId: 'proj_1', goal: 'G3', domain: 'a.com' })

    const proj1 = registry.listRuns({ sessionId: 'proj_1' })
    expect(proj1).toHaveLength(2)
  })

  it('lists runs filtered by status', () => {
    registry.startRun({ runId: 'r1', goal: 'G1', domain: 'a.com' })
    registry.startRun({ runId: 'r2', goal: 'G2', domain: 'a.com' })
    registry.completeRun('r1', { success: true, turnCount: 5 })

    const running = registry.listRuns({ status: 'running' })
    expect(running).toHaveLength(1)
    expect(running[0].runId).toBe('r2')

    const completed = registry.listRuns({ status: 'completed' })
    expect(completed).toHaveLength(1)
    expect(completed[0].runId).toBe('r1')
  })

  it('lists runs sorted newest first', () => {
    // Write manifests with explicit timestamps to avoid same-millisecond issue
    const runsDir = join(dir, 'agent-runs')
    mkdirSync(runsDir, { recursive: true })
    const base: Omit<RunManifest, 'runId' | 'updatedAt'> = {
      status: 'completed', goal: 'G', domain: 'a.com',
      startedAt: '2026-01-01T00:00:00Z', artifactPaths: [], turnCount: 1,
    }
    writeFileSync(join(runsDir, 'r1.json'), JSON.stringify({ ...base, runId: 'r1', updatedAt: '2026-01-01T00:00:00Z' }))
    writeFileSync(join(runsDir, 'r2.json'), JSON.stringify({ ...base, runId: 'r2', updatedAt: '2026-01-03T00:00:00Z' }))
    writeFileSync(join(runsDir, 'r3.json'), JSON.stringify({ ...base, runId: 'r3', updatedAt: '2026-01-02T00:00:00Z' }))

    const runs = registry.listRuns()
    expect(runs).toHaveLength(3)
    expect(runs[0].runId).toBe('r2')
    expect(runs[1].runId).toBe('r3')
    expect(runs[2].runId).toBe('r1')
  })

  it('respects limit', () => {
    for (let i = 0; i < 10; i++) {
      registry.startRun({ runId: `r${i}`, goal: `G${i}`, domain: 'a.com' })
    }
    const limited = registry.listRuns({ limit: 3 })
    expect(limited).toHaveLength(3)
  })

  it('builds resume scenario from completed run', () => {
    registry.startRun({
      runId: 'r1',
      sessionId: 'proj_1',
      goal: 'Build the app',
      domain: 'example.com',
      startUrl: 'https://example.com',
    })
    registry.completeRun('r1', {
      success: true,
      finalUrl: 'https://example.com/project/123',
      turnCount: 8,
    })

    const resume = registry.buildResumeScenario('r1', 'Add dark mode')
    expect(resume).toBeDefined()
    expect(resume!.goal).toBe('Add dark mode')
    expect(resume!.startUrl).toBe('https://example.com/project/123')
    expect(resume!.sessionId).toBe('proj_1')
    expect(resume!.parentRunId).toBe('r1')
  })

  it('resume without new goal reuses original goal', () => {
    registry.startRun({ runId: 'r1', goal: 'Build the app', domain: 'a.com' })
    registry.completeRun('r1', { success: true, finalUrl: 'https://a.com/done', turnCount: 5 })

    const resume = registry.buildResumeScenario('r1')
    expect(resume!.goal).toBe('Build the app')
  })

  it('builds fork scenario with new sessionId', () => {
    registry.startRun({
      runId: 'r1',
      sessionId: 'proj_1',
      goal: 'Build the app',
      domain: 'example.com',
    })
    registry.completeRun('r1', {
      success: true,
      finalUrl: 'https://example.com/project/123',
      turnCount: 8,
    })

    const fork = registry.buildForkScenario('r1', 'Add auth to a copy')
    expect(fork).toBeDefined()
    expect(fork!.goal).toBe('Add auth to a copy')
    expect(fork!.startUrl).toBe('https://example.com/project/123')
    expect(fork!.sessionId).toMatch(/^fork_/)
    expect(fork!.parentRunId).toBe('r1')
  })

  it('returns undefined for nonexistent run', () => {
    expect(registry.getRun('nope')).toBeUndefined()
    expect(registry.buildResumeScenario('nope')).toBeUndefined()
    expect(registry.buildForkScenario('nope', 'x')).toBeUndefined()
    expect(registry.completeRun('nope', { success: true, turnCount: 0 })).toBeUndefined()
  })

  it('persists across registry instances', () => {
    registry.startRun({ runId: 'r1', goal: 'Build', domain: 'a.com' })
    registry.completeRun('r1', { success: true, turnCount: 5 })

    const registry2 = new RunRegistry(dir)
    const manifest = registry2.getRun('r1')
    expect(manifest).toBeDefined()
    expect(manifest!.status).toBe('completed')
  })

  it('generates unique run IDs', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 100; i++) {
      ids.add(RunRegistry.generateRunId())
    }
    expect(ids.size).toBe(100)
  })

  it('updates partial fields', () => {
    registry.startRun({ runId: 'r1', goal: 'Build', domain: 'a.com' })
    registry.updateRun('r1', { turnCount: 3, finalUrl: 'https://a.com/mid' })

    const m = registry.getRun('r1')
    expect(m!.turnCount).toBe(3)
    expect(m!.finalUrl).toBe('https://a.com/mid')
    expect(m!.status).toBe('running')
  })

  it('tracks parentRunId through start', () => {
    registry.startRun({
      runId: 'r1',
      goal: 'Build the app',
      domain: 'a.com',
    })
    registry.completeRun('r1', { success: true, finalUrl: 'https://a.com/done', turnCount: 5 })

    // Start a child run with parentRunId
    registry.startRun({
      runId: 'r2',
      sessionId: 'proj_1',
      parentRunId: 'r1',
      goal: 'Add auth',
      domain: 'a.com',
    })

    const child = registry.getRun('r2')
    expect(child!.parentRunId).toBe('r1')
    expect(child!.sessionId).toBe('proj_1')
  })

  it('tracks currentUrl during mid-run updates', () => {
    registry.startRun({ runId: 'r1', goal: 'Navigate', domain: 'a.com' })

    registry.updateRun('r1', { currentUrl: 'https://a.com/page1', turnCount: 1 })
    expect(registry.getRun('r1')!.currentUrl).toBe('https://a.com/page1')

    registry.updateRun('r1', { currentUrl: 'https://a.com/page2', turnCount: 2 })
    expect(registry.getRun('r1')!.currentUrl).toBe('https://a.com/page2')

    // currentUrl is live state, finalUrl is set on completion
    expect(registry.getRun('r1')!.finalUrl).toBeUndefined()
  })

  it('stores artifact paths on completion', () => {
    registry.startRun({ runId: 'r1', goal: 'Build', domain: 'a.com' })
    registry.completeRun('r1', {
      success: true,
      turnCount: 5,
      artifactPaths: ['file:///out/r1/turn-001.jpg', 'file:///out/r1/recording.webm'],
    })

    const m = registry.getRun('r1')
    expect(m!.artifactPaths).toEqual([
      'file:///out/r1/turn-001.jpg',
      'file:///out/r1/recording.webm',
    ])
  })

  it('resume inherits parentRunId for lineage chain', () => {
    registry.startRun({ runId: 'r1', goal: 'Build', domain: 'a.com' })
    registry.completeRun('r1', { success: true, finalUrl: 'https://a.com/v1', turnCount: 5 })

    const resume = registry.buildResumeScenario('r1', 'Add feature')!
    registry.startRun({
      runId: 'r2',
      parentRunId: resume.parentRunId,
      sessionId: resume.sessionId,
      goal: resume.goal,
      domain: 'a.com',
    })
    registry.completeRun('r2', { success: true, finalUrl: 'https://a.com/v2', turnCount: 3 })

    const r2 = registry.getRun('r2')!
    expect(r2.parentRunId).toBe('r1')

    // Chain continues
    const resume2 = registry.buildResumeScenario('r2', 'Add more')!
    expect(resume2.parentRunId).toBe('r2')
  })
})
