import { describe, it, expect, vi } from 'vitest';
import { CompositeSink } from '../src/artifacts/composite-sink.js';
import type { Artifact, ArtifactSink, ArtifactManifestEntry } from '../src/artifacts/types.js';

function makeArtifact(): Artifact {
  return {
    type: 'screenshot',
    testId: 'test-1',
    name: 'turn-05.jpg',
    data: Buffer.from('fake-data'),
    contentType: 'image/jpeg',
  };
}

function makeMockSink(uri: string): ArtifactSink {
  const manifest: ArtifactManifestEntry[] = [];
  return {
    put: vi.fn(async (artifact: Artifact) => {
      manifest.push({
        testId: artifact.testId,
        type: artifact.type,
        name: artifact.name,
        uri,
        contentType: artifact.contentType,
        sizeBytes: artifact.data.length,
      });
      return uri;
    }),
    getManifest: vi.fn(() => [...manifest]),
    close: vi.fn(async () => {}),
  };
}

describe('CompositeSink', () => {
  it('throws when constructed with zero sinks', () => {
    expect(() => new CompositeSink([])).toThrow('at least one sink');
  });

  it('writes to all sinks and returns primary URI', async () => {
    const primary = makeMockSink('file:///primary/a.jpg');
    const secondary = makeMockSink('s3://bucket/a.jpg');

    const composite = new CompositeSink([primary, secondary]);
    const uri = await composite.put(makeArtifact());

    expect(uri).toBe('file:///primary/a.jpg');
    expect(primary.put).toHaveBeenCalledOnce();
    expect(secondary.put).toHaveBeenCalledOnce();
  });

  it('returns manifest from primary sink', async () => {
    const primary = makeMockSink('file:///primary/a.jpg');
    const secondary = makeMockSink('s3://bucket/a.jpg');

    const composite = new CompositeSink([primary, secondary]);
    await composite.put(makeArtifact());

    const manifest = composite.getManifest();
    expect(manifest).toHaveLength(1);
    expect(manifest[0].uri).toBe('file:///primary/a.jpg');
  });

  it('closes all sinks in parallel', async () => {
    const primary = makeMockSink('file:///a.jpg');
    const secondary = makeMockSink('s3://a.jpg');

    const composite = new CompositeSink([primary, secondary]);
    await composite.close();

    expect(primary.close).toHaveBeenCalledOnce();
    expect(secondary.close).toHaveBeenCalledOnce();
  });
});
