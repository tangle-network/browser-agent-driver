/**
 * FilesystemSink — writes artifacts to local disk.
 *
 * Directory layout:
 *   {baseDir}/
 *   ├── {testId}/
 *   │   ├── turn-05.jpg
 *   │   ├── recording.webm
 *   │   ├── events.jsonl    ← sub-turn TurnEvents from the bus
 *   │   └── trajectory.json
 *   ├── suite/
 *   │   ├── report.json
 *   │   └── report.md
 *   └── manifest.json
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Artifact, ArtifactSink, ArtifactManifestEntry } from './types.js';
import type { TurnEvent } from '../runner/events.js';
import { serializeForJsonl } from '../runner/events.js';

export class FilesystemSink implements ArtifactSink {
  private manifest: ArtifactManifestEntry[] = [];
  /**
   * Open append handles for events.jsonl files, keyed by testId. Used by
   * `appendEvent()` to avoid open()/close() per write — hot path.
   */
  private eventStreams = new Map<string, fs.WriteStream>();

  constructor(private baseDir: string) {
    fs.mkdirSync(baseDir, { recursive: true });
  }

  /**
   * Append a TurnEvent to `<baseDir>/<testId>/events.jsonl`. Each event is
   * serialized as a single JSON line via `serializeForJsonl` (which strips
   * screenshot data URLs to keep wire/disk size sane).
   *
   * The first call for a given testId opens an append-mode WriteStream that
   * stays open until `closeEventStream(testId)` or `close()`. This avoids
   * the open/close overhead on every event — sub-turn events fire frequently
   * during a run and a fresh fd per write would be wasteful.
   */
  appendEvent(testId: string, event: TurnEvent): void {
    let stream = this.eventStreams.get(testId);
    if (!stream) {
      const dir = path.join(this.baseDir, testId);
      fs.mkdirSync(dir, { recursive: true });
      stream = fs.createWriteStream(path.join(dir, 'events.jsonl'), {
        flags: 'a',
        encoding: 'utf-8',
      });
      this.eventStreams.set(testId, stream);
    }
    // serializeForJsonl returns a string with no trailing newline; add one
    // so jsonl readers can split on \n cleanly.
    stream.write(`${serializeForJsonl(event)}\n`);
  }

  /**
   * Flush + close the events.jsonl stream for a single test. Called by the
   * runner when a test completes so files are visible to viewers immediately.
   */
  closeEventStream(testId: string): Promise<void> {
    const stream = this.eventStreams.get(testId);
    if (!stream) return Promise.resolve();
    this.eventStreams.delete(testId);
    return new Promise((resolve) => {
      stream.end(() => resolve());
    });
  }

  async put(artifact: Artifact): Promise<string> {
    const dir = path.join(this.baseDir, artifact.testId);
    fs.mkdirSync(dir, { recursive: true });

    const filePath = path.join(dir, artifact.name);
    const data = this.resolveArtifactData(artifact, filePath);
    fs.writeFileSync(filePath, data);

    const uri = `file://${path.resolve(filePath)}`;

    this.manifest.push({
      testId: artifact.testId,
      type: artifact.type,
      name: artifact.name,
      uri,
      contentType: artifact.contentType,
      sizeBytes: data.length,
      metadata: artifact.metadata,
    });

    return uri;
  }

  getManifest(): ArtifactManifestEntry[] {
    return [...this.manifest];
  }

  async close(): Promise<void> {
    // Flush every open events.jsonl stream so the files are complete on disk
    // before we exit. Tests + viewers depend on this.
    const streamCloses = Array.from(this.eventStreams.keys()).map((id) => this.closeEventStream(id));
    await Promise.all(streamCloses);
    // Write manifest as final artifact
    const manifestPath = path.join(this.baseDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(this.manifest, null, 2));
  }

  private resolveArtifactData(artifact: Artifact, filePath: string): Buffer {
    if (artifact.type !== 'video' || artifact.data.length > 0) {
      return artifact.data;
    }

    // Playwright can report the video file before bytes are fully flushed.
    // Fall back to the non-empty capture under {sink}/_videos when available.
    const fallback = this.findLatestNonEmptyVideo(path.dirname(path.dirname(filePath)));
    return fallback ?? artifact.data;
  }

  private findLatestNonEmptyVideo(rootDir: string): Buffer | null {
    const videosDir = path.join(rootDir, '_videos');
    if (!fs.existsSync(videosDir)) return null;

    const candidates = fs.readdirSync(videosDir)
      .filter((entry) => entry.endsWith('.webm'))
      .map((entry) => {
        const p = path.join(videosDir, entry);
        const stat = fs.statSync(p);
        return {
          path: p,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        };
      })
      .filter((entry) => entry.size > 0)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    if (candidates.length === 0) return null;
    return fs.readFileSync(candidates[0].path);
  }
}
