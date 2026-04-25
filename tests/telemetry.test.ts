import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  TelemetryClient,
  setTelemetryClient,
  resetTelemetryClient,
  getTelemetry,
  setCliVersion,
  setInvocation,
  shortHash,
  FileTelemetrySink,
  FanoutTelemetrySink,
  NullTelemetrySink,
  type TelemetryEnvelope,
  type TelemetrySink,
} from '../src/telemetry/index.js'

class CapturingSink implements TelemetrySink {
  envelopes: TelemetryEnvelope[] = []
  emit(envelope: TelemetryEnvelope): void {
    this.envelopes.push(envelope)
  }
}

beforeEach(() => {
  resetTelemetryClient()
  setCliVersion('test')
})

describe('telemetry', () => {
  describe('shortHash', () => {
    it('is deterministic and 12 hex chars', () => {
      const h = shortHash('hello world')
      expect(h).toMatch(/^[0-9a-f]{12}$/)
      expect(shortHash('hello world')).toBe(h)
      expect(shortHash('hello world!')).not.toBe(h)
    })
  })

  describe('TelemetryClient', () => {
    it('emits a fully-shaped envelope', () => {
      const sink = new CapturingSink()
      setTelemetryClient(new TelemetryClient(sink))
      setInvocation('design-audit', ['design-audit', '--url', 'https://x'])

      getTelemetry().emit({
        kind: 'design-audit-page',
        runId: 'r1',
        ok: true,
        durationMs: 123,
        data: { url: 'https://x' },
        metrics: { score: 7.5 },
      })

      expect(sink.envelopes).toHaveLength(1)
      const env = sink.envelopes[0]!
      expect(env.schemaVersion).toBe(1)
      expect(env.envelopeId).toMatch(/^[0-9a-f-]{36}$/)
      expect(env.runId).toBe('r1')
      expect(env.kind).toBe('design-audit-page')
      expect(env.ok).toBe(true)
      expect(env.durationMs).toBe(123)
      expect(env.metrics.score).toBe(7.5)
      expect(env.source.cliVersion).toBe('test')
      expect(env.source.invocation).toBe('design-audit')
      expect(env.source.repo).toBeTruthy()
      expect(env.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    it('redacts secret-bearing argv flags', () => {
      const sink = new CapturingSink()
      setTelemetryClient(new TelemetryClient(sink))
      setInvocation('run', ['run', '--api-key', 'sk-secret', '--url', 'http://x', '--token=abc'])
      getTelemetry().emit({ kind: 'agent-run', runId: 'r1', ok: true, durationMs: 0 })

      const argv = sink.envelopes[0]!.source.argv
      expect(argv).toEqual(['run', '--api-key', '<redacted>', '--url', 'http://x', '--token=<redacted>'])
    })

    it('never throws when the underlying sink throws', () => {
      const blowingSink: TelemetrySink = {
        emit() {
          throw new Error('disk full')
        },
      }
      setTelemetryClient(new TelemetryClient(blowingSink))
      expect(() => getTelemetry().emit({ kind: 'agent-run', runId: 'r1', ok: true, durationMs: 0 })).not.toThrow()
    })
  })

  describe('FileTelemetrySink', () => {
    it('writes one JSONL row per envelope, partitioned by repo/date', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-tel-'))
      const sink = new FileTelemetrySink(dir)
      setTelemetryClient(new TelemetryClient(sink))
      setInvocation('design-audit')
      const t = getTelemetry()
      t.emit({ kind: 'design-audit-run', runId: 'r1', ok: true, durationMs: 1, metrics: { avgScore: 8 } })
      t.emit({ kind: 'design-audit-page', runId: 'r1', parentRunId: 'r1', ok: true, durationMs: 2, metrics: { score: 7 } })
      await sink.close()

      const repos = fs.readdirSync(dir)
      expect(repos.length).toBe(1)
      const files = fs.readdirSync(path.join(dir, repos[0]!))
      expect(files.length).toBe(1)
      const lines = fs
        .readFileSync(path.join(dir, repos[0]!, files[0]!), 'utf-8')
        .trim()
        .split('\n')
      expect(lines).toHaveLength(2)
      const parsed = lines.map((l) => JSON.parse(l) as TelemetryEnvelope)
      expect(parsed[0]!.kind).toBe('design-audit-run')
      expect(parsed[1]!.kind).toBe('design-audit-page')
      expect(parsed[1]!.parentRunId).toBe('r1')
    })
  })

  describe('FanoutTelemetrySink', () => {
    it('continues fanout when one sink throws', () => {
      const good = new CapturingSink()
      const bad: TelemetrySink = {
        emit() {
          throw new Error('boom')
        },
      }
      const fan = new FanoutTelemetrySink([bad, good])
      setTelemetryClient(new TelemetryClient(fan))
      getTelemetry().emit({ kind: 'agent-run', runId: 'r1', ok: true, durationMs: 0 })
      expect(good.envelopes).toHaveLength(1)
    })
  })

  describe('NullTelemetrySink', () => {
    it('drops envelopes silently', () => {
      const sink = new NullTelemetrySink()
      setTelemetryClient(new TelemetryClient(sink))
      expect(() => getTelemetry().emit({ kind: 'agent-run', runId: 'r1', ok: true, durationMs: 0 })).not.toThrow()
    })
  })

  describe('host-injected source overrides', () => {
    const ORIGINAL_ENV = { ...process.env }
    beforeEach(() => {
      delete process.env.BAD_SOURCE_REPO
      delete process.env.BAD_TENANT_ID
      delete process.env.BAD_CUSTOMER_ID
      delete process.env.BAD_API_KEY_HASH
      delete process.env.BAD_PARENT_RUN_ID
    })
    afterAll(() => {
      Object.assign(process.env, ORIGINAL_ENV)
    })

    it('uses BAD_SOURCE_REPO when set (skips git inference)', () => {
      process.env.BAD_SOURCE_REPO = 'bad-app'
      const sink = new CapturingSink()
      setTelemetryClient(new TelemetryClient(sink))
      getTelemetry().emit({ kind: 'agent-run', runId: 'r1', ok: true, durationMs: 0 })
      expect(sink.envelopes[0]!.source.repo).toBe('bad-app')
      // git fields should NOT be filled when override is set
      expect(sink.envelopes[0]!.source.gitSha).toBeUndefined()
      expect(sink.envelopes[0]!.source.gitBranch).toBeUndefined()
    })

    it('attaches tenantId / customerId / apiKeyHash from env', () => {
      process.env.BAD_SOURCE_REPO = 'bad-app'
      process.env.BAD_TENANT_ID = 'workspace-abc'
      process.env.BAD_CUSTOMER_ID = 'suite-xyz'
      process.env.BAD_API_KEY_HASH = '0123456789ab'
      const sink = new CapturingSink()
      setTelemetryClient(new TelemetryClient(sink))
      getTelemetry().emit({ kind: 'agent-run', runId: 'r1', ok: true, durationMs: 0 })
      expect(sink.envelopes[0]!.source.tenantId).toBe('workspace-abc')
      expect(sink.envelopes[0]!.source.customerId).toBe('suite-xyz')
      expect(sink.envelopes[0]!.source.apiKeyHash).toBe('0123456789ab')
    })

    it('uses BAD_PARENT_RUN_ID when caller did not set parentRunId', () => {
      process.env.BAD_SOURCE_REPO = 'bad-app'
      process.env.BAD_PARENT_RUN_ID = 'worker-run-42'
      const sink = new CapturingSink()
      setTelemetryClient(new TelemetryClient(sink))
      getTelemetry().emit({ kind: 'design-audit-page', runId: 'page-1', ok: true, durationMs: 1 })
      expect(sink.envelopes[0]!.parentRunId).toBe('worker-run-42')
    })

    it('explicit parentRunId beats BAD_PARENT_RUN_ID', () => {
      process.env.BAD_SOURCE_REPO = 'bad-app'
      process.env.BAD_PARENT_RUN_ID = 'env-parent'
      const sink = new CapturingSink()
      setTelemetryClient(new TelemetryClient(sink))
      getTelemetry().emit({
        kind: 'design-audit-page',
        runId: 'r1',
        parentRunId: 'explicit-parent',
        ok: true,
        durationMs: 1,
      })
      expect(sink.envelopes[0]!.parentRunId).toBe('explicit-parent')
    })
  })
})
