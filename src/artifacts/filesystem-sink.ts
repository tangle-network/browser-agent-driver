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
    fs.writeFileSync(filePath, artifact.data);

    const uri = `file://${path.resolve(filePath)}`;

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
    // Write manifest as final artifact
    const manifestPath = path.join(this.baseDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(this.manifest, null, 2));
  }
}
