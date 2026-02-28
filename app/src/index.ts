/**
 * @tangle-network/agent-driver-app — sandbox orchestration for agent-browser-driver
 *
 * Distributes test suites across isolated sandbox environments for parallel execution.
 */

// Core types
export type {
  SandboxProvider,
  SandboxConfig,
  Sandbox,
  SandboxStatus,
  SandboxInfo,
  ExecOptions,
  ExecResult,
  FileEntry,
  CoordinatorConfig,
  CoordinatorEvent,
  AggregatedResult,
  ArtifactSummary,
  ManifestEntry,
  AgentConfig,
  ProviderConfig,
  DockerProviderConfig,
  TangleProviderConfig,
} from './types.js';

// Re-exported upstream types
export type { TestCase, TestSuiteResult, ProgressEvent } from './types.js';

// Coordinator
export { Coordinator } from './coordinator.js';

// Providers
export {
  DockerSandboxProvider,
  TangleSandboxProvider,
  createProvider,
} from './providers/index.js';
