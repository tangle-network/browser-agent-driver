import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FilesystemSink } from '../src/artifacts/filesystem-sink.js';
import type { Artifact } from '../src/artifacts/types.js';

function makeArtifact(overrides?: Partial<Artifact>): Artifact {
  return {
    type: 'screenshot',
    testId: 'test-1',
    name: 'turn-05.jpg',
    data: Buffer.from('fake-jpeg-data'),
    contentType: 'image/jpeg',
    ...overrides,
  };
}

describe('FilesystemSink', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abd-fssink-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates output directory on construction', () => {
    const dir = path.join(tmpDir, 'nested', 'output');
    new FilesystemSink(dir);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('writes artifact data to correct path', async () => {
    const sink = new FilesystemSink(tmpDir);
    const artifact = makeArtifact();

    const uri = await sink.put(artifact);

    const expectedPath = path.join(tmpDir, 'test-1', 'turn-05.jpg');
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(fs.readFileSync(expectedPath).toString()).toBe('fake-jpeg-data');
    expect(uri).toBe(`file://${path.resolve(expectedPath)}`);
  });

  it('tracks manifest entries', async () => {
    const sink = new FilesystemSink(tmpDir);

    await sink.put(makeArtifact({ testId: 'a', name: 'a.jpg' }));
    await sink.put(makeArtifact({ testId: 'b', name: 'b.jpg' }));

    const manifest = sink.getManifest();
    expect(manifest).toHaveLength(2);
    expect(manifest[0].testId).toBe('a');
    expect(manifest[0].name).toBe('a.jpg');
    expect(manifest[0].sizeBytes).toBe(Buffer.from('fake-jpeg-data').length);
    expect(manifest[1].testId).toBe('b');
  });

  it('writes manifest.json on close()', async () => {
    const sink = new FilesystemSink(tmpDir);
    await sink.put(makeArtifact());

    await sink.close();

    const manifestPath = path.join(tmpDir, 'manifest.json');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(manifest).toHaveLength(1);
    expect(manifest[0].testId).toBe('test-1');
  });

  it('returns a copy of manifest (not the internal array)', async () => {
    const sink = new FilesystemSink(tmpDir);
    await sink.put(makeArtifact());

    const m1 = sink.getManifest();
    const m2 = sink.getManifest();
    expect(m1).not.toBe(m2);
    expect(m1).toEqual(m2);
  });

  it('falls back to non-empty _videos capture when video artifact payload is empty', async () => {
    const sink = new FilesystemSink(tmpDir);
    const videosDir = path.join(tmpDir, '_videos');
    fs.mkdirSync(videosDir, { recursive: true });
    fs.writeFileSync(path.join(videosDir, 'latest.webm'), Buffer.from('REALWEBM'));

    const uri = await sink.put(makeArtifact({
      type: 'video',
      testId: 'video-case',
      name: 'recording.webm',
      data: Buffer.alloc(0),
      contentType: 'video/webm',
    }));

    const resolvedPath = path.join(tmpDir, 'video-case', 'recording.webm');
    expect(uri).toBe(`file://${path.resolve(resolvedPath)}`);
    expect(fs.readFileSync(resolvedPath).toString()).toBe('REALWEBM');

    const manifest = sink.getManifest();
    expect(manifest).toHaveLength(1);
    expect(manifest[0].type).toBe('video');
    expect(manifest[0].sizeBytes).toBe(Buffer.from('REALWEBM').length);
  });
});
