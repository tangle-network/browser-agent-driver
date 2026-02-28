/**
 * CompositeSink — chains multiple sinks together.
 *
 * Useful for writing to both filesystem (local debugging) and S3 (cloud storage)
 * simultaneously. The primary sink's URI is returned from put().
 */

import type { Artifact, ArtifactSink, ArtifactManifestEntry } from './types.js';

export class CompositeSink implements ArtifactSink {
  constructor(private sinks: ArtifactSink[]) {
    if (sinks.length === 0) {
      throw new Error('CompositeSink requires at least one sink');
    }
  }

  async put(artifact: Artifact): Promise<string> {
    const uris = await Promise.all(this.sinks.map(s => s.put(artifact)));
    return uris[0]; // Primary sink's URI
  }

  getManifest(): ArtifactManifestEntry[] {
    // Return manifest from primary sink
    return this.sinks[0].getManifest();
  }

  async close(): Promise<void> {
    await Promise.all(this.sinks.map(s => s.close?.()));
  }
}
