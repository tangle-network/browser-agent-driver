/**
 * Sandbox orchestration types — pluggable provider abstraction for distributing
 * agent-browser-driver test suites across isolated environments.
 */

import type {
  TestCase,
  TestSuiteResult,
} from '@tangle-network/agent-browser-driver';
import type { ProgressEvent } from '@tangle-network/agent-browser-driver';

// ============================================================================
// Sandbox Provider
// ============================================================================

/** Configuration for provisioning a sandbox */
export interface SandboxConfig {
  /** Unique ID for this sandbox (auto-generated if omitted) */
  id?: string;
  /** Environment variables to inject */
  env?: Record<string, string>;
  /** Resource limits */
  resources?: {
    cpus?: number;
    memoryMb?: number;
    timeoutMs?: number;
  };
  /** Provider-specific config (e.g., Docker image name, region, instance type) */
  providerConfig?: Record<string, unknown>;
}

/** File metadata returned by listFiles */
export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
}

/** Options for command execution */
export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/** Result of a completed command */
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type SandboxStatus = 'ready' | 'running' | 'completed' | 'failed' | 'destroyed';

/** A provisioned sandbox instance */
export interface Sandbox {
  readonly id: string;
  readonly status: SandboxStatus;

  /** Execute a command, wait for completion */
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;

  /** Execute a command, stream stdout line-by-line */
  execStream(command: string, options?: ExecOptions): AsyncIterable<string>;

  /** Write a file into the sandbox */
  writeFile(path: string, content: string | Buffer): Promise<void>;

  /** Read a file from the sandbox */
  readFile(path: string): Promise<Buffer>;

  /** List directory contents */
  listFiles(path: string): Promise<FileEntry[]>;

  /**
   * Copy an entire directory from sandbox to local filesystem.
   * Optional — providers that support efficient bulk copy (e.g., Docker)
   * should implement this. Falls back to file-by-file extraction if not available.
   */
  copyDirectory?(remotePath: string, localPath: string): Promise<void>;

  /** Destroy this sandbox and release resources */
  destroy(): Promise<void>;
}

/** Pluggable backend for provisioning and managing sandboxes */
export interface SandboxProvider {
  /** Provider name (e.g., 'docker', 'tangle') */
  readonly name: string;

  /** Provision a new sandbox. Resolves when sandbox is ready for commands. */
  provision(config: SandboxConfig): Promise<Sandbox>;

  /** List active sandboxes managed by this provider */
  list(): Promise<SandboxInfo[]>;

  /** Tear down all active sandboxes */
  destroyAll(): Promise<void>;
}

/** Summary info about a sandbox */
export interface SandboxInfo {
  id: string;
  status: SandboxStatus;
  createdAt?: Date;
}

// ============================================================================
// Coordinator
// ============================================================================

/** Agent/LLM configuration passed to each sandbox */
export interface AgentConfig {
  model: string;
  provider: string;
  apiKey?: string;
  baseUrl?: string;
  vision?: boolean;
  goalVerification?: boolean;
  maxTurns?: number;
  headless?: boolean;
}

/** Configuration for the coordinator */
export interface CoordinatorConfig {
  /** Sandbox provider to use */
  provider: SandboxProvider;
  /** Max concurrent sandboxes */
  concurrency: number;
  /** Test cases to execute */
  cases: TestCase[];
  /** Agent/LLM config passed to each sandbox */
  agentConfig: AgentConfig;
  /** Progress callback */
  onProgress?: (event: CoordinatorEvent) => void;
  /** Local directory for collected artifacts */
  outputDir?: string;
}

/** Aggregated result across all sandboxes */
export interface AggregatedResult {
  /** Per-sandbox suite results */
  suiteResults: TestSuiteResult[];
  /** Merged summary across all sandboxes */
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    passRate: number;
    totalDurationMs: number;
    sandboxesUsed: number;
  };
  /** Timestamp of this aggregated run */
  timestamp: string;
}

/** Events emitted by the coordinator during execution */
export type CoordinatorEvent =
  | { type: 'coordinator:start'; totalTests: number; sandboxes: number }
  | { type: 'sandbox:provisioned'; sandboxId: string; testsAssigned: number }
  | { type: 'sandbox:started'; sandboxId: string }
  | { type: 'sandbox:progress'; sandboxId: string; event: ProgressEvent }
  | { type: 'sandbox:artifacts'; sandboxId: string; artifacts: ArtifactSummary }
  | { type: 'sandbox:completed'; sandboxId: string; passed: number; failed: number }
  | { type: 'sandbox:failed'; sandboxId: string; error: string }
  | { type: 'coordinator:complete'; result: AggregatedResult };

/** Summary of artifacts collected from a sandbox */
export interface ArtifactSummary {
  /** Total files collected */
  fileCount: number;
  /** Total bytes collected */
  totalBytes: number;
  /** Breakdown by type (e.g., { screenshot: 3, video: 2, report: 1 }) */
  byType: Record<string, number>;
  /** Local directory where artifacts were written */
  localDir: string;
}

// ============================================================================
// Provider Registry
// ============================================================================

/** Options for creating a provider via the registry */
export interface DockerProviderConfig {
  /** Docker image to use (default: 'agent-driver') */
  image?: string;
  /** Extra docker run args */
  dockerArgs?: string[];
}

export interface TangleProviderConfig {
  /** Tangle sandbox API key */
  apiKey?: string;
  /** Orchestrator base URL */
  baseUrl?: string;
  /** Sandbox image preset */
  image?: string;
}

/** A single entry in the artifact manifest produced by agent-driver */
export interface ManifestEntry {
  testId: string;
  type: string;
  name: string;
  uri: string;
  contentType: string;
  sizeBytes: number;
  metadata?: Record<string, string>;
}

export type ProviderConfig =
  | { type: 'docker'; config?: DockerProviderConfig }
  | { type: 'tangle'; config: TangleProviderConfig };

// Re-export upstream types used in our API surface
export type { TestCase, TestSuiteResult, ProgressEvent };
