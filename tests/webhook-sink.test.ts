import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebhookSink } from '../src/artifacts/webhook-sink.js';
import type { Artifact, ArtifactType } from '../src/artifacts/types.js';

function makeArtifact(overrides?: Partial<Artifact>): Artifact {
  return {
    type: 'screenshot',
    testId: 'test-1',
    name: 'turn-05.jpg',
    data: Buffer.from('fake-image-data'),
    contentType: 'image/jpeg',
    metadata: { turn: '5' },
    ...overrides,
  };
}

describe('WebhookSink', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs artifact metadata on put()', async () => {
    const sink = new WebhookSink({ url: 'https://hooks.example.com/test', retries: 0 });
    const artifact = makeArtifact();

    await sink.put(artifact);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://hooks.example.com/test');
    expect(opts.method).toBe('POST');

    const body = JSON.parse(opts.body);
    expect(body.event).toBe('artifact');
    expect(body.testId).toBe('test-1');
    expect(body.type).toBe('screenshot');
    expect(body.name).toBe('turn-05.jpg');
    expect(body.sizeBytes).toBe(Buffer.from('fake-image-data').length);
    expect(body.data).toBeUndefined(); // includeData defaults to false
  });

  it('includes base64 data when includeData is true', async () => {
    const sink = new WebhookSink({
      url: 'https://hooks.example.com/test',
      includeData: true,
      retries: 0,
    });
    const artifact = makeArtifact();

    await sink.put(artifact);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.data).toBe(Buffer.from('fake-image-data').toString('base64'));
  });

  it('skips data encoding for artifacts exceeding maxPayloadBytes', async () => {
    const sink = new WebhookSink({
      url: 'https://hooks.example.com/test',
      includeData: true,
      maxPayloadBytes: 5, // Very small limit
      retries: 0,
    });
    const artifact = makeArtifact({ data: Buffer.from('this-is-way-too-large') });

    await sink.put(artifact);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.data).toBeUndefined();
  });

  it('filters by event type when events is set', async () => {
    const sink = new WebhookSink({
      url: 'https://hooks.example.com/test',
      events: ['video'] as ArtifactType[],
      retries: 0,
    });

    // Screenshot should be filtered out
    await sink.put(makeArtifact({ type: 'screenshot' }));
    expect(fetchMock).not.toHaveBeenCalled();

    // Video should go through
    await sink.put(makeArtifact({ type: 'video', name: 'recording.webm' }));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('sends custom headers', async () => {
    const sink = new WebhookSink({
      url: 'https://hooks.example.com/test',
      headers: { Authorization: 'Bearer token-123' },
      retries: 0,
    });

    await sink.put(makeArtifact());

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['Authorization']).toBe('Bearer token-123');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('retries on failure with exponential backoff', async () => {
    vi.useFakeTimers();

    fetchMock
      .mockRejectedValueOnce(new Error('network error'))
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const sink = new WebhookSink({
      url: 'https://hooks.example.com/test',
      retries: 3,
    });

    const putPromise = sink.put(makeArtifact());

    // First attempt fails immediately, then waits 1s
    await vi.advanceTimersByTimeAsync(1000);
    // Second attempt fails, then waits 2s
    await vi.advanceTimersByTimeAsync(2000);
    // Third attempt succeeds

    await putPromise;
    expect(fetchMock).toHaveBeenCalledTimes(3);

    vi.useRealTimers();
  });

  it('never throws even when all retries fail', async () => {
    fetchMock.mockRejectedValue(new Error('permanent failure'));

    const sink = new WebhookSink({
      url: 'https://hooks.example.com/test',
      retries: 0, // No retries — fail immediately
    });

    // Should not throw
    await expect(sink.put(makeArtifact())).resolves.toBeDefined();
  });

  it('tracks manifest across multiple put() calls', async () => {
    const sink = new WebhookSink({ url: 'https://hooks.example.com/test', retries: 0 });

    await sink.put(makeArtifact({ testId: 'a', name: 'a.jpg' }));
    await sink.put(makeArtifact({ testId: 'b', name: 'b.jpg' }));

    const manifest = sink.getManifest();
    expect(manifest).toHaveLength(2);
    expect(manifest[0].testId).toBe('a');
    expect(manifest[1].testId).toBe('b');
  });

  it('sends suite:complete on close() without summary by default', async () => {
    const sink = new WebhookSink({ url: 'https://hooks.example.com/test', retries: 0 });

    await sink.put(makeArtifact());
    fetchMock.mockClear();

    await sink.close();

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.event).toBe('suite:complete');
    expect(body.manifest).toHaveLength(1);
    expect(body.summary).toBeUndefined();
  });

  it('includes summary in close() when provided', async () => {
    const sink = new WebhookSink({ url: 'https://hooks.example.com/test', retries: 0 });

    await sink.close({ total: 5, passed: 4, failed: 1 });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.summary).toEqual({ total: 5, passed: 4, failed: 1 });
  });

  it('does not retry on 4xx client errors (except 429)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400 });

    const sink = new WebhookSink({
      url: 'https://hooks.example.com/test',
      retries: 3,
    });

    await sink.put(makeArtifact());

    // Only one attempt — no retries for 400
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
