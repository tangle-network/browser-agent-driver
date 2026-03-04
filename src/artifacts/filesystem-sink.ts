/**
 * FilesystemSink — writes artifacts to local disk.
 *
 * Directory layout:
 *   {baseDir}/
 *   ├── {testId}/
 *   │   ├── turn-05.jpg
 *   │   ├── recording.webm
 *   │   └── trajectory.json
 *   ├── suite/
 *   │   ├── report.json
 *   │   └── report.md
 *   └── manifest.json
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Artifact, ArtifactSink, ArtifactManifestEntry } from './types.js';

export class FilesystemSink implements ArtifactSink {
  private manifest: ArtifactManifestEntry[] = [];

  constructor(private baseDir: string) {
    fs.mkdirSync(baseDir, { recursive: true });
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
