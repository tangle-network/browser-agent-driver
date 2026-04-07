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
  const BrowserAgent = vi.fn(function (this: { run: typeof mockRunFn }, opts: { onTurn?: (turn: Turn) => void }) {
    latestOnTurn = opts.onTurn;
    this.run = mockRunFn;
  });
  return { BrowserAgent };
});

function makeDriver(videoPath: string): Driver {
  return makeDriverWithPage(videoPath);
}

function makeDriverWithPage(videoPath: string, page?: import('playwright').Page): Driver {
  return {
    observe: vi.fn(async () => ({ url: 'http://localhost', title: 'Test', snapshot: '' })),
    execute: vi.fn(async () => ({ success: true })),
    getPage: () => page ?? ({
      video: () => ({
        path: async () => videoPath,
        // Mirror the canonical Playwright video.saveAs() API the runner now
        // calls. We copy the fake video bytes from the videoPath the test
        // wrote to disk into the runner's chosen target.
        saveAs: async (target: string) => {
          const fsm = await import('node:fs');
          if (videoPath && fsm.existsSync(videoPath)) {
            fsm.copyFileSync(videoPath, target);
          }
        },
      }),
      close: async () => {},
    }) as unknown as import('playwright').Page,
    close: vi.fn(async () => {}),
  };
}

class MemorySink implements ArtifactSink {
  manifest: ArtifactManifestEntry[] = [];
  closeManifestSize = 0;
  storedData = new Map<string, Buffer>();

  async put(artifact: Artifact): Promise<string> {
    const uri = `mem://${artifact.testId}/${artifact.name}`;
    this.storedData.set(uri, artifact.data);
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

class FakeTracing {
  async start(): Promise<void> {}

  async stop(options?: { path?: string }): Promise<void> {
    if (options?.path) {
      fs.writeFileSync(options.path, Buffer.from('TRACEZIP'));
    }
  }
}

class FakePage {
  private handlers = new Map<string, Set<(payload: unknown) => void>>();
  private tracing = new FakeTracing();

  constructor(private videoPath: string) {}

  on(event: string, handler: (payload: unknown) => void): this {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return this;
  }

  off(event: string, handler: (payload: unknown) => void): this {
    this.handlers.get(event)?.delete(handler);
    return this;
  }

  emit(event: string, payload: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(payload);
    }
  }

  video() {
    return {
      path: async () => this.videoPath,
      // The runner now calls video.saveAs() (the canonical Playwright API
      // that waits for the recording to finalize on context close). Mock
      // by copying our fake video bytes to the requested target.
      saveAs: async (target: string) => {
        const fsm = await import('node:fs');
        if (this.videoPath && fsm.existsSync(this.videoPath)) {
          fsm.copyFileSync(this.videoPath, target);
        }
      },
    };
  }

  // The runner closes the page before saveAs to flush the video stream.
  // No-op in the test mock — we just track that close was called.
  closed = false;
  async close(): Promise<void> {
    this.closed = true;
  }

  context() {
    return {
      tracing: this.tracing,
    };
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

  it('captures runtime observability artifacts for failed runs', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abd-observe-'));
    const videoPath = path.join(tmpDir, 'recording.webm');
    fs.writeFileSync(videoPath, Buffer.from('FAKEWEBM'));
    const fakePage = new FakePage(videoPath);

    mockRunFn.mockImplementation(async () => {
      fakePage.emit('console', {
        type: () => 'error',
        text: () => 'console exploded',
        location: () => ({ url: 'http://localhost/app.js', lineNumber: 7, columnNumber: 2 }),
      });
      fakePage.emit('pageerror', new Error('page exploded'));
      fakePage.emit('requestfailed', {
        url: () => 'http://localhost/api',
        method: () => 'GET',
        resourceType: () => 'xhr',
        failure: () => ({ errorText: 'net::ERR_FAILED' }),
      });
      fakePage.emit('response', {
        url: () => 'http://localhost/api',
        status: () => 500,
        statusText: () => 'Internal Server Error',
        request: () => ({
          method: () => 'GET',
          resourceType: () => 'xhr',
        }),
      });

      return {
        success: false,
        reason: 'Server failed',
        turns: [],
        totalMs: 20,
      };
    });

    const sink = new MemorySink();
    const runner = new TestRunner({
      driver: makeDriverWithPage(videoPath, fakePage as unknown as import('playwright').Page),
      artifactSink: sink,
      config: {
        observability: {
          enabled: true,
          tracePolicy: 'on-failure',
        },
      },
    });

    const result = await runner.runSuite([
      {
        id: 'observe-failure',
        name: 'Observability failure',
        startUrl: 'http://localhost',
        goal: 'Fail with diagnostics',
      },
    ]);

    expect(result.summary.failed).toBe(1);
    const artifactKeys = sink.manifest.map((entry) => `${entry.type}:${entry.name}`);
    expect(artifactKeys).toContain('runtime-log:runtime-log.json');
    expect(artifactKeys).toContain('trace:trace.zip');

    const runtimeLogUri = sink.manifest.find((entry) => entry.type === 'runtime-log')?.uri;
    expect(runtimeLogUri).toBeTruthy();
    const runtimeLog = JSON.parse(sink.storedData.get(String(runtimeLogUri))!.toString('utf-8'));
    expect(runtimeLog.console[0]?.text).toBe('console exploded');
    expect(runtimeLog.pageErrors[0]?.message).toContain('page exploded');
    expect(runtimeLog.requestFailures[0]?.errorText).toContain('ERR_FAILED');
    expect(runtimeLog.responseErrors[0]?.status).toBe('500');
    expect(runtimeLog.traceCaptured).toBe(true);
  });
});
