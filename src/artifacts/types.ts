/**
 * Artifact pipeline types — pluggable storage for test artifacts.
 *
 * Artifacts flow through an ArtifactSink interface that can be backed by
 * filesystem, S3, R2, or any custom storage. The agent-driver package
 * ships FilesystemSink; cloud sinks live in consumer repos.
 */

/** Categories of artifacts produced during test execution */
export type ArtifactType =
  | 'screenshot'
  | 'video'
  | 'runtime-log'
  | 'trace'
  | 'report-json'
  | 'report-md'
  | 'report-html'
  | 'report-junit'
  | 'trajectory'
  | 'knowledge'
  | 'checkpoint';

/** A single artifact produced during a test run */
export interface Artifact {
  /** Artifact category */
  type: ArtifactType;
  /** Test case ID that produced this (or 'suite' for aggregate artifacts) */
  testId: string;
  /** Filename (e.g., 'turn-15.jpg', 'report.json') */
  name: string;
  /** Binary content */
  data: Buffer;
  /** MIME type (e.g., 'image/jpeg', 'application/json') */
  contentType: string;
  /** Arbitrary metadata (turn number, model, timestamp, etc.) */
  metadata?: Record<string, string>;
}

/**
 * Pluggable storage backend for artifacts.
 *
 * Implement this interface to route artifacts to S3, R2, GCS, or
 * any custom storage. The built-in FilesystemSink writes to local disk.
 */
export interface ArtifactSink {
  /**
   * Store an artifact. Returns a URI for retrieval.
   * - Filesystem: file:///path/to/artifact
   * - S3: s3://bucket/key
   * - HTTP: https://cdn.example.com/path
   */
  put(artifact: Artifact): Promise<string>;

  /**
   * Return a manifest of all artifacts stored so far.
   * Each entry maps artifact name → URI.
   */
  getManifest(): ArtifactManifestEntry[];

  /** Finalize — flush buffers, close connections, emit manifest. */
  close?(): Promise<void>;
}

export interface ArtifactManifestEntry {
  testId: string;
  type: ArtifactType;
  name: string;
  uri: string;
  contentType: string;
  sizeBytes: number;
  metadata?: Record<string, string>;
}

/** Real-time progress events emitted during suite execution */
export type ProgressEvent =
  | { type: 'suite:start'; totalTests: number; concurrency: number }
  | { type: 'test:start'; testId: string; testName: string; workerId: number }
  | { type: 'test:turn'; testId: string; turn: number; action: string; durationMs: number; tokensUsed?: number }
  | { type: 'test:artifact'; testId: string; artifactType: ArtifactType; uri: string }
  | { type: 'test:complete'; testId: string; passed: boolean; verdict: string; durationMs: number; turnsUsed: number; tokensUsed: number; estimatedCostUsd?: number }
  | { type: 'suite:complete'; passed: number; failed: number; skipped: number; totalMs: number; totalCostUsd?: number; manifestUri?: string };
