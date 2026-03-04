import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TestRunner } from '../src/test-runner.js';
import type { Scenario, AgentResult, Turn, ProgressEvent } from '../src/types.js';
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

function makeDriver(videoPath: string): Driver {
  return {
    observe: vi.fn(async () => ({ url: 'http://localhost', title: 'Test', snapshot: '' })),
    execute: vi.fn(async () => ({ success: true })),
    getPage: () => ({
      video: () => ({
        path: async () => videoPath,
      }),
    }) as unknown as import('playwright').Page,
    close: vi.fn(async () => {}),
  };
}

class MemorySink implements ArtifactSink {
  manifest: ArtifactManifestEntry[] = [];
  closeManifestSize = 0;

  async put(artifact: Artifact): Promise<string> {
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

describe('TestRunner critical flows', () => {
  beforeEach(() => {
    mockRunFn.mockReset();
    latestOnTurn = undefined;
  });

  it('emits progress events and persists screenshot/video/report/manifest artifacts', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abd-critical-'));
    const videoPath = path.join(tmpDir, 'recording.webm');
    fs.writeFileSync(videoPath, Buffer.from('FAKEWEBM'));

    mockRunFn.mockImplementation(async () => {
      latestOnTurn?.({
        turn: 1,
        state: {
          url: 'http://localhost',
          title: 'Test',
          snapshot: 'snapshot',
          screenshot: Buffer.from('img').toString('base64'),
        },
        action: { action: 'click', selector: '#cta' },
        durationMs: 12,
      });

      return {
        success: true,
        result: 'done',
        turns: [],
        totalMs: 32,
      };
    });

    const sink = new MemorySink();
    const events: ProgressEvent[] = [];
    const runner = new TestRunner({
      driver: makeDriver(videoPath),
      artifactSink: sink,
      screenshotInterval: 1,
      onProgress: (event) => events.push(event),
    });

    const result = await runner.runSuite([
      {
        id: 'critical-1',
        name: 'Critical path',
        startUrl: 'http://localhost',
        goal: 'Complete the flow',
      },
    ]);

    expect(result.summary.total).toBe(1);
    expect(result.summary.passed).toBe(1);

    const artifactKeys = sink.manifest.map((entry) => `${entry.type}:${entry.name}`);
    expect(artifactKeys).toContain('screenshot:turn-001.jpg');
    expect(artifactKeys).toContain('video:recording.webm');
    expect(artifactKeys).toContain('report-json:report.json');
    expect(artifactKeys).toContain('report-md:report.md');
    expect(artifactKeys).toContain('report-json:manifest.json');
    expect(sink.closeManifestSize).toBe(sink.manifest.length);

    expect(events[0]?.type).toBe('suite:start');
    expect(events.some((event) => event.type === 'test:start')).toBe(true);
    expect(events.some((event) => event.type === 'test:turn')).toBe(true);
    expect(events.some((event) => event.type === 'test:complete')).toBe(true);

    const suiteComplete = events.find((event) => event.type === 'suite:complete');
    expect(suiteComplete?.type).toBe('suite:complete');
    if (suiteComplete?.type === 'suite:complete') {
      expect(suiteComplete.manifestUri).toBe('mem://suite/manifest.json');
    }

    const screenshotEventIdx = events.findIndex(
      (event) => event.type === 'test:artifact' && event.artifactType === 'screenshot',
    );
    const suiteCompleteIdx = events.findIndex((event) => event.type === 'suite:complete');
    expect(screenshotEventIdx).toBeGreaterThan(-1);
    expect(suiteCompleteIdx).toBeGreaterThan(screenshotEventIdx);
  });

  it('marks a test failed when the agent fails and no explicit success criteria are provided', async () => {
    mockRunFn.mockResolvedValue({
      success: false,
      reason: '3 consecutive errors: API key missing',
      turns: [],
      totalMs: 10,
    });

    const runner = new TestRunner({
      driver: makeDriver('/tmp/nonexistent-video.webm'),
    });

    const result = await runner.runSuite([
      {
        id: 'critical-failure-default',
        name: 'Failure without criteria',
        startUrl: 'http://localhost',
        goal: 'Do the thing',
      },
    ]);

    expect(result.summary.total).toBe(1);
    expect(result.summary.passed).toBe(0);
    expect(result.summary.failed).toBe(1);
    expect(result.results[0]?.verified).toBe(false);
    expect(result.results[0]?.agentSuccess).toBe(false);
    expect(result.results[0]?.verdict).toContain('API key missing');
  });
});
