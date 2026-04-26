import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluatePatches } from '../bench/design/eval/patches.js'

function writeReport(dir: string, name: string, payload: object): string {
  const reportDir = join(dir, name)
  mkdirSync(reportDir, { recursive: true })
  const file = join(reportDir, 'report.json')
  writeFileSync(file, JSON.stringify(payload))
  return reportDir
}

describe('evaluatePatches', () => {
  let dir: string
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('is unmeasured when no patches are emitted', () => {
    dir = mkdtempSync(join(tmpdir(), 'bad-eval-'))
    writeReport(dir, 'r1', { pages: [{ snapshot: 'hello world', findings: [{ id: 'f1', patches: [] }] }] })
    const flow = evaluatePatches({ roots: [dir] })
    expect(flow.status).toBe('unmeasured')
  })

  it('passes when every patch has its before in the snapshot', () => {
    dir = mkdtempSync(join(tmpdir(), 'bad-eval-'))
    writeReport(dir, 'r1', {
      pages: [{
        snapshot: 'this contains color: red somewhere',
        findings: [{
          id: 'f1', severity: 'major',
          patches: [{
            patchId: 'p1', findingId: 'f1', scope: 'component',
            target: { scope: 'css', filePath: 'a.css', selector: '.x' },
            diff: { before: 'color: red', after: 'color: blue' },
            testThatProves: { kind: 'visual-regression' },
            rollback: { kind: 'css-disable' },
            estimatedDelta: { dim: 'visual_craft', delta: 1 },
            estimatedDeltaConfidence: 'high',
          }],
        }],
      }],
    })
    const flow = evaluatePatches({ roots: [dir] })
    expect(flow.status).toBe('pass')
    expect(flow.score).toBe(1)
  })

  it('fails when before is not in the snapshot', () => {
    dir = mkdtempSync(join(tmpdir(), 'bad-eval-'))
    writeReport(dir, 'r1', {
      pages: [{
        snapshot: 'unrelated content',
        findings: [{
          id: 'f1', severity: 'major',
          patches: [{
            patchId: 'p-bad', findingId: 'f1', scope: 'component',
            target: { scope: 'css', filePath: 'a.css', selector: '.x' },
            diff: { before: 'color: red', after: 'color: blue' },
            testThatProves: { kind: 'visual-regression' },
            rollback: { kind: 'css-disable' },
            estimatedDelta: { dim: 'visual_craft', delta: 1 },
            estimatedDeltaConfidence: 'high',
          }],
        }],
      }],
    })
    const flow = evaluatePatches({ roots: [dir], target: 0.95 })
    expect(flow.status).toBe('fail')
    expect(flow.score).toBe(0)
    const detail = flow.detail as { failures: Array<{ patchId: string }> }
    expect(detail.failures[0].patchId).toBe('p-bad')
  })

  it('aggregates across multiple report files', () => {
    dir = mkdtempSync(join(tmpdir(), 'bad-eval-'))
    writeReport(dir, 'r1', {
      pages: [{ snapshot: 'has color: red here', findings: [{ id: 'f1', patches: [{
        patchId: 'p1', findingId: 'f1', scope: 'component',
        target: { scope: 'css', filePath: 'a.css', selector: '.x' },
        diff: { before: 'color: red', after: 'color: blue' },
        testThatProves: { kind: 'visual-regression' }, rollback: { kind: 'css-disable' },
        estimatedDelta: { dim: 'visual_craft', delta: 1 }, estimatedDeltaConfidence: 'high',
      }] }] }],
    })
    writeReport(dir, 'r2', {
      pages: [{ snapshot: 'no match here', findings: [{ id: 'f2', patches: [{
        patchId: 'p2', findingId: 'f2', scope: 'component',
        target: { scope: 'css', filePath: 'b.css', selector: '.y' },
        diff: { before: 'NOT THERE', after: 'replacement' },
        testThatProves: { kind: 'visual-regression' }, rollback: { kind: 'css-disable' },
        estimatedDelta: { dim: 'visual_craft', delta: 1 }, estimatedDeltaConfidence: 'high',
      }] }] }],
    })
    const flow = evaluatePatches({ roots: [dir] })
    const d = flow.detail as { total: number; valid: number }
    expect(d.total).toBe(2)
    expect(d.valid).toBe(1)
    expect(flow.score).toBe(0.5)
  })
})
