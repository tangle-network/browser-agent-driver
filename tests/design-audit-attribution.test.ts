import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  patchHash,
  appendPatchApplication,
  readRecentApplications,
  findPendingApplication,
  updateApplicationOutcome,
} from '../src/design/audit/attribution/store.js'
import { aggregatePatchReliability, recommendationFor } from '../src/design/audit/attribution/aggregate.js'
import type { PatchApplication } from '../src/design/audit/attribution/types.js'

function makeApp(overrides: Partial<PatchApplication> = {}): PatchApplication {
  return {
    applicationId: `app-${Math.random().toString(36).slice(2)}`,
    patchId: 'patch-001',
    patchHash: 'abc123',
    appliedAt: new Date().toISOString(),
    appliedBy: 'agent:claude-code',
    preAuditRunId: 'run-pre',
    predicted: { dim: 'visual_craft', delta: 2 },
    ...overrides,
  }
}

describe('patchHash', () => {
  it('produces stable output for same inputs', () => {
    const h1 = patchHash({ before: 'color: red', after: 'color: blue' }, 'component')
    const h2 = patchHash({ before: 'color: red', after: 'color: blue' }, 'component')
    expect(h1).toBe(h2)
    expect(h1).toHaveLength(16)
  })

  it('produces different hashes for different scope', () => {
    const h1 = patchHash({ before: 'a', after: 'b' }, 'component')
    const h2 = patchHash({ before: 'a', after: 'b' }, 'page')
    expect(h1).not.toBe(h2)
  })
})

describe('attribution store', () => {
  let tmpDir: string
  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('appends and reads back an application', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bad-attr-'))
    const app = makeApp()
    await appendPatchApplication(app, tmpDir)

    const apps = await readRecentApplications(1, tmpDir)
    expect(apps).toHaveLength(1)
    expect(apps[0].applicationId).toBe(app.applicationId)
  })

  it('is append-only: file grows on second write', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bad-attr-'))
    const a1 = makeApp({ applicationId: 'first' })
    const a2 = makeApp({ applicationId: 'second' })
    await appendPatchApplication(a1, tmpDir)
    await appendPatchApplication(a2, tmpDir)

    const apps = await readRecentApplications(1, tmpDir)
    expect(apps.length).toBeGreaterThanOrEqual(2)
  })

  it('finds a pending application by patchId', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bad-attr-'))
    const app = makeApp({ patchId: 'patch-findme' })
    await appendPatchApplication(app, tmpDir)

    const found = await findPendingApplication('patch-findme', tmpDir)
    expect(found).not.toBeNull()
    expect(found!.applicationId).toBe(app.applicationId)
  })

  it('does not find a pending application when postAuditRunId is set', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bad-attr-'))
    const app = makeApp({ patchId: 'patch-done', postAuditRunId: 'run-post' })
    await appendPatchApplication(app, tmpDir)

    const found = await findPendingApplication('patch-done', tmpDir)
    expect(found).toBeNull()
  })

  it('appends an outcome event and the agreementScore is computed', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bad-attr-'))
    const app = makeApp({ predicted: { dim: 'visual_craft', delta: 2 } })
    await appendPatchApplication(app, tmpDir)

    await updateApplicationOutcome(
      app.applicationId,
      'run-post',
      { dim: 'visual_craft', delta: 1.5 },
      tmpDir,
    )

    const apps = await readRecentApplications(1, tmpDir)
    const outcome = apps.find(a => a.applicationId === app.applicationId && a.postAuditRunId)
    expect(outcome).toBeDefined()
    expect(outcome!.agreementScore).toBeGreaterThan(0)
  })
})

describe('aggregatePatchReliability', () => {
  it('produces recommended when N≥30, tenants≥5, replicationRate≥0.7', () => {
    const hash = 'deadbeef'
    const apps: PatchApplication[] = Array.from({ length: 30 }, (_, i) => ({
      applicationId: `app-${i}`,
      patchId: 'p',
      patchHash: hash,
      appliedAt: new Date().toISOString(),
      appliedBy: `agent:tenant-${i % 6}`,
      preAuditRunId: 'pre',
      predicted: { dim: 'visual_craft', delta: 2 },
      observed: { dim: 'visual_craft', delta: 2 },
    }))

    const [rel] = aggregatePatchReliability(apps)
    expect(rel.patchHash).toBe(hash)
    expect(rel.recommendation).toBe('recommended')
    expect(rel.replicationRate).toBeCloseTo(1.0)
  })

  it('produces antipattern when N≥10, low replication, negative observed delta', () => {
    const hash = 'baadf00d'
    const apps: PatchApplication[] = Array.from({ length: 10 }, (_, i) => ({
      applicationId: `app-${i}`,
      patchId: 'p',
      patchHash: hash,
      appliedAt: new Date().toISOString(),
      appliedBy: 'agent:a',
      preAuditRunId: 'pre',
      predicted: { dim: 'visual_craft', delta: 2 },
      observed: { dim: 'visual_craft', delta: -1 },
    }))

    const [rel] = aggregatePatchReliability(apps)
    expect(rel.recommendation).toBe('antipattern')
  })
})

describe('recommendationFor', () => {
  it('is neutral below thresholds', () => {
    expect(recommendationFor(5, 2, 0.5, 1)).toBe('neutral')
  })
})
