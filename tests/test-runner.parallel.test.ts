import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestRunner } from '../src/test-runner.js';
import type { Scenario, AgentResult, Turn, TestCase } from '../src/types.js';
import type { Driver } from '../src/drivers/types.js';
import type { Artifact, ArtifactManifestEntry, ArtifactSink } from '../src/artifacts/types.js';

const mockRunFn = vi.fn<(scenario: Scenario) => Promise<AgentResult>>();
let latestOnTurn: ((turn: Turn) => void) | undefined;

vi.mock('../src/runner.js', () => {
  const AgentRunner = vi.fn(function (this: { run: typeof mockRunFn }, opts: { onTurn?: (turn: Turn) => void }) {
    latestOnTurn = opts.onTurn;
    this.run = mockRunFn;
  });
  return { AgentRunner };
});

function makeDriver(closeSpy?: ReturnType<typeof vi.fn>): Driver {
  return {
    observe: vi.fn(async () => ({ url: 'http://localhost', title: 'Test', snapshot: '' })),
    execute: vi.fn(async () => ({ success: true })),
    close: closeSpy ?? vi.fn(async () => {}),
  };
}

class MemorySink implements ArtifactSink {
  manifest: ArtifactManifestEntry[] = [];
  closeManifestSize = 0;

  async put(artifact: Artifact): Promise<string> {
    if (artifact.type === 'screenshot') {
      await new Promise((r) => setTimeout(r, 25));
    }
    const uri = `mem://${artifact.testId}/${artifact.name}`;
    this.manifest.push({
      testId: artifact.testId,
      type: artifact.type,
      name: artifact.name,
      uri,
      contentType: artifact.contentType,
      sizeBytes: artifact.data.length,
      metadata: artifact.metadata,
    });
    return uri;
  }

  getManifest(): ArtifactManifestEntry[] {
    return [...this.manifest];
  }

  async close(): Promise<void> {
    this.closeManifestSize = this.manifest.length;
  }
}

describe('TestRunner parallel reliability', () => {
  beforeEach(() => {
    mockRunFn.mockReset();
    latestOnTurn = undefined;
  });

  it('marks unresolved cyclic dependencies as skipped instead of hanging', async () => {
    const closeA = vi.fn(async () => {});
    const closeB = vi.fn(async () => {});
    const closeSpies = [closeA, closeB];
    let idx = 0;

    const runner = new TestRunner({
      driverFactory: async () => makeDriver(closeSpies[idx++] ?? vi.fn(async () => {})),
      concurrency: 2,
    });

    const cases: TestCase[] = [
      {
        id: 'a',
        name: 'A',
        startUrl: 'http://localhost',
        goal: 'A',
        dependsOn: ['b'],
      },
      {
        id: 'b',
        name: 'B',
        startUrl: 'http://localhost',
        goal: 'B',
        dependsOn: ['a'],
      },
    ];

    const result = await runner.runSuite(cases);
    expect(result.summary.skipped).toBe(2);
    expect(result.results[0].skipped).toBe(true);
    expect(result.results[1].skipped).toBe(true);
    expect(result.results[0].skipReason).toMatch(/Unresolved dependencies|deadlock/i);
  });

  it('aborts timed out workers and reports skipped timeout result', async () => {
    const closeSpy = vi.fn(async () => {});
    mockRunFn.mockImplementation(async (scenario) => {
      await new Promise<void>((resolve) => {
        const tick = () => {
          if (scenario.signal?.aborted) return resolve();
          setTimeout(tick, 10);
        };
        tick();
      });
      return {
        success: false,
        reason: String(scenario.signal?.reason || 'Cancelled'),
        turns: [],
        totalMs: 120,
      };
    });

    const runner = new TestRunner({
      driverFactory: async () => makeDriver(closeSpy),
      concurrency: 2,
      workerTimeoutMs: 50,
    });

    const result = await runner.runSuite([
      { id: 't1', name: 'Timeout case', startUrl: 'http://localhost', goal: 'Do work' },
    ]);

    expect(result.summary.skipped).toBe(1);
    expect(result.results[0].skipped).toBe(true);
    expect(result.results[0].skipReason).toContain('Worker timed out');
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('flushes pending screenshot artifact writes before manifest/close', async () => {
    mockRunFn.mockImplementation(async () => {
      latestOnTurn?.({
        turn: 1,
        state: {
          url: 'http://localhost',
          title: 'Test',
          snapshot: 'snapshot',
          screenshot: Buffer.from('img').toString('base64'),
        },
        action: { action: 'click', selector: '#go' },
        durationMs: 5,
      });

      return {
        success: true,
        result: 'done',
        turns: [],
        totalMs: 15,
      };
    });

    const sink = new MemorySink();
    const runner = new TestRunner({
      driver: makeDriver(),
      concurrency: 1,
      screenshotInterval: 1,
      artifactSink: sink,
    });

    const result = await runner.runSuite([
      { id: 't1', name: 'Artifacts', startUrl: 'http://localhost', goal: 'Capture artifacts' },
    ]);

    expect(result.summary.total).toBe(1);
    expect(sink.manifest.some((e) => e.type === 'screenshot')).toBe(true);
    expect(sink.closeManifestSize).toBe(sink.manifest.length);
  });
});
