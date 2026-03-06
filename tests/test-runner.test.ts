import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Driver } from '../src/drivers/types.js';
import type { AgentResult, TestCase } from '../src/types.js';

const mockRun = vi.fn<(scenario: { signal?: AbortSignal }) => Promise<AgentResult>>();

vi.mock('../src/runner.js', () => {
  const AgentRunner = vi.fn(function (this: { run: typeof mockRun }) {
    this.run = mockRun;
  });
  return { AgentRunner };
});

import { TestRunner } from '../src/test-runner.js';

function makeDriver(): Driver {
  return {
    observe: vi.fn(async () => ({ url: 'http://localhost', title: 'Test', snapshot: '' })),
    execute: vi.fn(async () => ({ success: true })),
    close: vi.fn(async () => {}),
    getPage: vi.fn(() => undefined),
    screenshot: vi.fn(async () => ''),
  };
}

function makeSuccessResult(): AgentResult {
  return {
    success: true,
    result: 'ok',
    turns: [],
    totalMs: 5,
    phaseTimings: { initialNavigateMs: 10, firstObserveMs: 20 },
    wasteMetrics: {
      repeatedQueryCount: 1,
      verificationRejectionCount: 0,
      turnsAfterSufficientEvidence: 0,
      errorTurns: 0,
    },
  };
}

function makeCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: 'tc-1',
    name: 'test case',
    startUrl: 'http://localhost',
    goal: 'do thing',
    ...overrides,
  };
}

describe('TestRunner hardening', () => {
  beforeEach(() => {
    mockRun.mockReset();
    mockRun.mockResolvedValue(makeSuccessResult());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses config timeout when testCase.timeoutMs is absent', async () => {
    vi.useFakeTimers();
    mockRun.mockImplementation(() => new Promise<AgentResult>(() => {}));

    const runner = new TestRunner({
      driver: makeDriver(),
      config: { model: 'gpt-4o' },
      defaultTimeoutMs: 25,
    });

    const promise = runner.runTest(makeCase({ id: 'fallback-timeout', timeoutMs: undefined }));
    await vi.advanceTimersByTimeAsync(25);
    const result = await promise;

    expect(result.agentSuccess).toBe(false);
    expect(result.agentResult.reason).toBe('Test timed out after 25ms');
    expect(result.verdict).toContain('25ms');
    expect(result.phaseTimings).toEqual({});
    expect(result.wasteMetrics).toEqual({
      repeatedQueryCount: 0,
      verificationRejectionCount: 0,
      turnsAfterSufficientEvidence: 0,
      errorTurns: 0,
    });
  });

  it('preserves per-case timeout precedence over config timeout', async () => {
    vi.useFakeTimers();
    mockRun.mockImplementation(() => new Promise<AgentResult>(() => {}));

    const runner = new TestRunner({
      driver: makeDriver(),
      config: { model: 'gpt-4o' },
      defaultTimeoutMs: 100,
    });

    const promise = runner.runTest(makeCase({ id: 'case-timeout', timeoutMs: 10 }));
    await vi.advanceTimersByTimeAsync(10);
    const result = await promise;

    expect(result.agentResult.reason).toBe('Test timed out after 10ms');
  });

  it('marks impossible dependency graphs as skipped instead of hanging in parallel mode', async () => {
    const driverFactory = vi.fn(async () => makeDriver());
    const runner = new TestRunner({
      driverFactory,
      concurrency: 3,
    });

    const suite = await runner.runSuite([
      makeCase({ id: 'missing', dependsOn: ['does-not-exist'] }),
      makeCase({ id: 'cycle-a', dependsOn: ['cycle-b'] }),
      makeCase({ id: 'cycle-b', dependsOn: ['cycle-a'] }),
    ]);

    const byId = new Map(suite.results.map((r) => [r.testCase.id, r]));

    expect(driverFactory).not.toHaveBeenCalled();
    expect(suite.summary.skipped).toBe(3);
    expect(byId.get('missing')?.skipReason).toBe('Dependencies not found: does-not-exist');
    expect(byId.get('cycle-a')?.skipReason).toContain('Unresolvable dependencies');
    expect(byId.get('cycle-b')?.skipReason).toContain('Unresolvable dependencies');
  });

  it('cleans worker timeout timers after race completion', async () => {
    vi.useFakeTimers();
    mockRun.mockResolvedValue(makeSuccessResult());

    const runner = new TestRunner({
      driverFactory: async () => makeDriver(),
      concurrency: 2,
      workerTimeoutMs: 1_000,
    });

    const suitePromise = runner.runSuite([makeCase({ id: 'timer-cleanup' })]);
    await vi.runAllTimersAsync();
    const suite = await suitePromise;

    expect(suite.summary.total).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('copies phase timing and waste metrics onto the test result', async () => {
    const runner = new TestRunner({
      driver: makeDriver(),
      config: { model: 'gpt-4o' },
    });

    const result = await runner.runTest(makeCase({ id: 'instrumented' }));

    expect(result.phaseTimings).toEqual({ initialNavigateMs: 10, firstObserveMs: 20 });
    expect(result.wasteMetrics).toEqual({
      repeatedQueryCount: 1,
      verificationRejectionCount: 0,
      turnsAfterSufficientEvidence: 0,
      errorTurns: 0,
    });
  });
});
