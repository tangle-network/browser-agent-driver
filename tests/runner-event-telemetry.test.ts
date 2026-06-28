import { describe, expect, it } from 'vitest'
import { TelemetryClient, type TelemetryEnvelope, type TelemetrySink } from '../src/telemetry/index.js'
import { TurnEventBus } from '../src/runner/events.js'
import { attachTurnEventTelemetry } from '../src/runner/event-telemetry.js'

const NOW = '2026-06-26T12:00:00.000Z'

class CapturingSink implements TelemetrySink {
  envelopes: TelemetryEnvelope[] = []

  emit(envelope: TelemetryEnvelope): void {
    this.envelopes.push(envelope)
  }
}

describe('attachTurnEventTelemetry', () => {
  it('emits compact agent-step envelopes from turn events', () => {
    const sink = new CapturingSink()
    const bus = new TurnEventBus()
    attachTurnEventTelemetry(bus, {
      telemetry: new TelemetryClient(sink),
      config: { provider: 'openai', model: 'gpt-5.4' },
    })

    bus.emit({
      type: 'decide-completed',
      ts: NOW,
      runId: 'run-1',
      turn: 1,
      action: { action: 'click', selector: '@b1' },
      reasoning: 'Click the primary result.',
      expectedEffect: 'Result page opens.',
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadInputTokens: 100,
      durationMs: 1200,
    })

    expect(sink.envelopes).toHaveLength(1)
    const envelope = sink.envelopes[0]!
    expect(envelope.kind).toBe('agent-step')
    expect(envelope.runId).toBe('run-1')
    expect(envelope.ok).toBe(true)
    expect(envelope.durationMs).toBe(1200)
    expect(envelope.model).toEqual({ provider: 'openai', name: 'gpt-5.4' })
    expect(envelope.tags).toMatchObject({ eventType: 'decide-completed', phase: 'decide', status: 'completed' })
    expect(envelope.metrics).toMatchObject({
      turn: 1,
      durationMs: 1200,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadInputTokens: 100,
    })
    expect(envelope.metrics.estimatedCostUsd).toBeCloseTo(0.005275, 8)
    expect(envelope.data).toMatchObject({
      eventType: 'decide-completed',
      phase: 'decide',
      toolName: 'click',
      expectedEffect: 'Result page opens.',
    })
    expect(envelope.data.spanId).toMatch(/^[0-9a-f]{12}$/)
    expect(envelope.data.parentSpanId).toMatch(/^[0-9a-f]{12}$/)
    expect(envelope.data.toolArgsHash).toMatch(/^[0-9a-f]{12}$/)
    expect(envelope.data.toolArgsPreview).toEqual({ action: 'click', selector: '@b1' })
  })

  it('records screenshot size without storing screenshot blobs', () => {
    const sink = new CapturingSink()
    const bus = new TurnEventBus()
    attachTurnEventTelemetry(bus, { telemetry: new TelemetryClient(sink) })

    bus.emit({
      type: 'observe-completed',
      ts: NOW,
      runId: 'run-1',
      turn: 1,
      url: 'https://example.com/search?q=secret#fragment',
      title: 'Example',
      snapshotBytes: 1234,
      screenshot: 'data:image/png;base64,' + 'A'.repeat(128),
      durationMs: 50,
    })

    const envelope = sink.envelopes[0]!
    expect(envelope.metrics.snapshotBytes).toBe(1234)
    expect(envelope.metrics.screenshotBytes).toBeGreaterThan(128)
    expect(envelope.data.url).toBe('https://example.com/search')
    expect(JSON.stringify(envelope)).not.toContain('data:image')
    expect(JSON.stringify(envelope)).not.toContain('q=secret')
  })

  it('hashes sensitive action values instead of previewing them', () => {
    const sink = new CapturingSink()
    const bus = new TurnEventBus()
    attachTurnEventTelemetry(bus, { telemetry: new TelemetryClient(sink) })

    bus.emit({
      type: 'execute-started',
      ts: NOW,
      runId: 'run-1',
      turn: 2,
      action: { action: 'type', selector: '@email', text: 'drew+secret@example.com' },
    })

    const json = JSON.stringify(sink.envelopes[0])
    expect(json).not.toContain('drew+secret@example.com')
    expect(sink.envelopes[0]!.data.toolArgsPreview).toMatchObject({
      action: 'type',
      selector: '@email',
      textLength: 23,
    })
    expect((sink.envelopes[0]!.data.toolArgsPreview as Record<string, unknown>).textHash).toMatch(/^[0-9a-f]{12}$/)
  })

  it('uses turn-completed model usage when a turn records adaptive routing', () => {
    const sink = new CapturingSink()
    const bus = new TurnEventBus()
    attachTurnEventTelemetry(bus, {
      telemetry: new TelemetryClient(sink),
      config: { provider: 'openai', model: 'gpt-5.4' },
    })

    bus.emit({
      type: 'turn-completed',
      ts: NOW,
      runId: 'run-1',
      turn: 3,
      turnArtifact: {
        turn: 3,
        state: { url: 'https://example.com', title: 'Example', snapshot: 'body' },
        action: { action: 'complete', result: 'done' },
        inputTokens: 20,
        outputTokens: 5,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 10,
        modelUsed: 'gpt-4.1-mini',
        durationMs: 300,
      },
    })

    expect(sink.envelopes[0]!.model).toEqual({ provider: 'openai', name: 'gpt-4.1-mini' })
    expect(sink.envelopes[0]!.metrics.turnCacheCreationInputTokens).toBe(10)
    expect(sink.envelopes[0]!.metrics.cacheCreationInputTokens).toBeUndefined()
    expect(sink.envelopes[0]!.metrics.estimatedCostUsd).toBeUndefined()
    expect(sink.envelopes[0]!.data.modelUsed).toBe('gpt-4.1-mini')
    expect(JSON.stringify(sink.envelopes[0])).not.toContain('done')
  })

  it('unsubscribes cleanly', () => {
    const sink = new CapturingSink()
    const bus = new TurnEventBus()
    const detach = attachTurnEventTelemetry(bus, { telemetry: new TelemetryClient(sink) })

    bus.emit({ type: 'turn-started', ts: NOW, runId: 'run-1', turn: 1 })
    detach()
    bus.emit({ type: 'turn-started', ts: NOW, runId: 'run-1', turn: 2 })

    expect(sink.envelopes).toHaveLength(1)
  })

  it('emits an agent-run summary with aggregate optimization metrics', () => {
    const sink = new CapturingSink()
    const bus = new TurnEventBus()
    attachTurnEventTelemetry(bus, {
      telemetry: new TelemetryClient(sink),
      config: { provider: 'openai', model: 'gpt-5.4' },
    })

    bus.emit({
      type: 'run-started',
      ts: NOW,
      runId: 'run-summary',
      turn: 0,
      goal: 'Book a refundable hotel',
      startUrl: 'https://example.com/?token=secret',
      maxTurns: 5,
    })
    bus.emit({
      type: 'observe-completed',
      ts: NOW,
      runId: 'run-summary',
      turn: 1,
      url: 'https://example.com/search?q=private',
      title: 'Search',
      snapshotBytes: 500,
      screenshot: 'data:image/png;base64,' + 'A'.repeat(10),
      durationMs: 20,
    })
    bus.emit({
      type: 'decide-completed',
      ts: NOW,
      runId: 'run-summary',
      turn: 1,
      action: { action: 'click', selector: '@book' },
      inputTokens: 100,
      outputTokens: 25,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 15,
      modelUsed: 'gpt-4.1-mini',
      durationMs: 200,
    })
    bus.emit({
      type: 'execute-completed',
      ts: NOW,
      runId: 'run-summary',
      turn: 1,
      action: { action: 'click', selector: '@book' },
      success: false,
      error: 'timeout waiting for navigation',
      durationMs: 300,
    })
    bus.emit({
      type: 'verify-completed',
      ts: NOW,
      runId: 'run-summary',
      turn: 1,
      verified: false,
      reason: 'booking page did not open',
      durationMs: 40,
    })
    bus.emit({
      type: 'turn-completed',
      ts: NOW,
      runId: 'run-summary',
      turn: 1,
      turnArtifact: {
        turn: 1,
        state: { url: 'https://example.com', title: 'Example', snapshot: 'body' },
        action: { action: 'click', selector: '@book' },
        inputTokens: 100,
        outputTokens: 25,
        cacheReadInputTokens: 10,
        cacheCreationInputTokens: 15,
        modelUsed: 'gpt-4.1-mini',
        durationMs: 600,
      },
    })
    bus.emit({
      type: 'run-completed',
      ts: NOW,
      runId: 'run-summary',
      turn: 0,
      success: false,
      totalTurns: 1,
      totalMs: 700,
      reason: 'timed out',
    })

    const summary = sink.envelopes.find((envelope) => envelope.kind === 'agent-run')
    expect(summary).toBeTruthy()
    expect(summary!.ok).toBe(false)
    expect(summary!.durationMs).toBe(700)
    expect(summary!.error).toBe('timed out')
    expect(summary!.metrics).toMatchObject({
      eventCount: 7,
      totalTurns: 1,
      completedTurns: 1,
      totalMs: 700,
      modelCallCount: 1,
      toolCallCount: 1,
      screenshotCount: 1,
      executeFailureCount: 1,
      verificationRejectionCount: 1,
      inputTokens: 100,
      outputTokens: 25,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 15,
      snapshotBytes: 500,
      maxTurns: 5,
    })
    expect(summary!.metrics.estimatedCostUsd).toBeCloseTo(0.000077, 8)
    expect(summary!.data).toMatchObject({
      eventType: 'run-summary',
      phase: 'run',
      status: 'failed',
      startUrl: 'https://example.com/',
      reason: 'timed out',
    })
    expect((summary!.data.eventCounts as Record<string, number>)['run-completed']).toBe(1)
    expect((summary!.data.actionCounts as Record<string, number>).click).toBe(1)
    expect((summary!.data.modelCounts as Record<string, number>)['openai:gpt-4.1-mini']).toBe(1)
    expect((summary!.data.errorCounts as Record<string, number>).timeout).toBe(2)
    expect((summary!.data.phaseDurationsMs as Record<string, number>)).toMatchObject({
      observe: 20,
      decide: 200,
      execute: 300,
      verify: 40,
    })
    expect(JSON.stringify(summary)).not.toContain('token=secret')
  })

  it('redacts goals and plan bodies from telemetry previews', () => {
    const sink = new CapturingSink()
    const bus = new TurnEventBus()
    attachTurnEventTelemetry(bus, { telemetry: new TelemetryClient(sink) })

    bus.emit({
      type: 'run-started',
      ts: NOW,
      runId: 'run-private',
      turn: 0,
      goal: 'Log in with drew+secret@example.com and token=abc123',
      startUrl: 'https://example.com/login?token=abc123',
      maxTurns: 3,
    })
    bus.emit({
      type: 'plan-completed',
      ts: NOW,
      runId: 'run-private',
      turn: 0,
      stepCount: 2,
      plan: {
        reasoning: 'Use drew+secret@example.com',
        finalResult: 'private token abc123',
        steps: [
          {
            action: { action: 'type', selector: '@email', text: 'drew+secret@example.com' },
            expectedEffect: 'email contains drew+secret@example.com',
            rationale: 'private email field',
          },
          {
            action: { action: 'navigate', url: 'https://example.com/next?token=abc123' },
            expectedEffect: 'token abc123 page opens',
          },
        ],
      },
      durationMs: 10,
    })

    const json = JSON.stringify(sink.envelopes)
    expect(json).not.toContain('drew+secret@example.com')
    expect(json).not.toContain('token=abc123')
    expect(json).not.toContain('private token abc123')
    expect(sink.envelopes[0]!.data).toMatchObject({
      goalHash: expect.any(String),
      goalLength: 52,
      startUrl: 'https://example.com/login',
    })
    expect(sink.envelopes[0]!.data).not.toHaveProperty('goalPreview')
    expect(sink.envelopes[1]!.data).toMatchObject({
      planHash: expect.any(String),
      planPreview: {
        stepCount: 2,
        finalResultLength: 20,
        reasoningLength: 27,
      },
    })
  })

  it('counts model calls even when usage is missing or cache-creation only', () => {
    const sink = new CapturingSink()
    const bus = new TurnEventBus()
    attachTurnEventTelemetry(bus, {
      telemetry: new TelemetryClient(sink),
      config: { provider: 'openai', model: 'gpt-5.4' },
    })

    bus.emit({
      type: 'plan-completed',
      ts: NOW,
      runId: 'usage-run',
      turn: 0,
      stepCount: 0,
      plan: { steps: [] },
      durationMs: 5,
      providerUsed: 'anthropic',
      modelUsed: 'claude-sonnet-4-6',
    })
    bus.emit({
      type: 'decide-completed',
      ts: NOW,
      runId: 'usage-run',
      turn: 1,
      action: { action: 'click', selector: '@next' },
      cacheCreationInputTokens: 50,
      modelUsed: 'gpt-4.1-mini',
      durationMs: 10,
    })
    bus.emit({
      type: 'run-completed',
      ts: NOW,
      runId: 'usage-run',
      turn: 0,
      success: true,
      totalTurns: 1,
      totalMs: 20,
    })

    const summary = sink.envelopes.find((envelope) => envelope.kind === 'agent-run')!
    expect(summary.metrics).toMatchObject({
      modelCallCount: 2,
      usageReportedCount: 1,
      missingUsageCount: 1,
      cacheCreationInputTokens: 50,
    })
    expect((summary.data.modelCounts as Record<string, number>)['anthropic:claude-sonnet-4-6']).toBe(1)
    expect((summary.data.modelCounts as Record<string, number>)['openai:gpt-4.1-mini']).toBe(1)
  })

  it('records failed planner calls with model usage and failure metadata', () => {
    const sink = new CapturingSink()
    const bus = new TurnEventBus()
    attachTurnEventTelemetry(bus, {
      telemetry: new TelemetryClient(sink),
      config: { provider: 'openai', model: 'gpt-5.4' },
    })

    bus.emit({
      type: 'plan-completed',
      ts: NOW,
      runId: 'plan-parse-fail',
      turn: 0,
      stepCount: 0,
      plan: null,
      durationMs: 123,
      parseError: 'Unexpected token } in JSON',
      inputTokens: 900,
      outputTokens: 40,
      cacheReadInputTokens: 100,
      cacheCreationInputTokens: 25,
      providerUsed: 'anthropic',
      modelUsed: 'claude-sonnet-4-6',
    })
    bus.emit({
      type: 'run-completed',
      ts: NOW,
      runId: 'plan-parse-fail',
      turn: 0,
      success: false,
      totalTurns: 0,
      totalMs: 130,
      reason: 'planner unavailable',
    })

    const step = sink.envelopes.find((envelope) => envelope.kind === 'agent-step')!
    expect(step.ok).toBe(false)
    expect(step.error).toBe('Unexpected token } in JSON')
    expect(step.tags).toMatchObject({ phase: 'plan', status: 'failed' })
    expect(step.model).toEqual({ provider: 'anthropic', name: 'claude-sonnet-4-6' })
    expect(step.metrics).toMatchObject({
      inputTokens: 900,
      outputTokens: 40,
      cacheReadInputTokens: 100,
      cacheCreationInputTokens: 25,
    })
    expect(step.data).toMatchObject({
      planFailure: 'parse_or_validation_error',
      planPreview: { stepCount: 0 },
      reason: 'Unexpected token } in JSON',
    })

    const summary = sink.envelopes.find((envelope) => envelope.kind === 'agent-run')!
    expect(summary.metrics).toMatchObject({
      modelCallCount: 1,
      usageReportedCount: 1,
      missingUsageCount: 0,
      inputTokens: 900,
      outputTokens: 40,
      cacheReadInputTokens: 100,
      cacheCreationInputTokens: 25,
    })
    expect((summary.data.modelCounts as Record<string, number>)['anthropic:claude-sonnet-4-6']).toBe(1)
    expect((summary.data.errorCounts as Record<string, number>).error).toBe(2)
  })

  it('marks failed plan steps as failed telemetry and summarizes them', () => {
    const sink = new CapturingSink()
    const bus = new TurnEventBus()
    attachTurnEventTelemetry(bus, { telemetry: new TelemetryClient(sink) })

    bus.emit({
      type: 'plan-step-executed',
      ts: NOW,
      runId: 'plan-fail',
      turn: 1,
      stepIndex: 1,
      totalSteps: 2,
      action: { action: 'click', selector: '@missing' },
      executeSuccess: false,
      verified: false,
      verifyReason: 'selector @missing not found',
      durationMs: 15,
    })
    bus.emit({
      type: 'run-completed',
      ts: NOW,
      runId: 'plan-fail',
      turn: 0,
      success: false,
      totalTurns: 1,
      totalMs: 20,
      reason: 'plan failed',
    })

    const step = sink.envelopes.find((envelope) => envelope.kind === 'agent-step')!
    expect(step.ok).toBe(false)
    expect(step.error).toBe('selector @missing not found')
    expect(step.tags).toMatchObject({ status: 'failed' })
    expect(step.data).toMatchObject({
      planStepStatus: 'failed',
      executionStatus: 'failure',
      verificationVerdict: 'rejected',
    })
    const summary = sink.envelopes.find((envelope) => envelope.kind === 'agent-run')!
    expect(summary.metrics).toMatchObject({
      planStepCount: 1,
      planStepFailureCount: 1,
    })
  })
})
