/**
 * @tangle-network/agent-browser-driver
 *
 * LLM-driven browser agent for UI automation, testing, and evaluation.
 * Built on Playwright with accessibility tree observation, planning,
 * verification, recovery, and trajectory memory.
 */

// Core types
export type {
  Action,
  ClickAction,
  TypeAction,
  PressAction,
  HoverAction,
  SelectAction,
  EvaluateAction,
  RunScriptAction,
  VerifyPreviewAction,
  ScrollAction,
  NavigateAction,
  WaitAction,
  CompleteAction,
  AbortAction,
  PageState,
  Scenario,
  AgentConfig,
  Turn,
  AgentResult,
  SuccessCriterion,
  TestCase,
  TestResult,
  CriterionResult,
  TestSuiteResult,
  Trajectory,
  TrajectoryStep,
  DesignFinding,
  FlowAuditResult,
  DesignAuditReport,
  AuditFlow,
  GoalVerification,
  PreviewVerification,
} from './types.js';

// Driver interface + implementations
export type { Driver, ActionResult } from './drivers/types.js';
export { PlaywrightDriver } from './drivers/playwright.js';
export type { PlaywrightDriverOptions } from './drivers/playwright.js';
export { AriaSnapshotHelper, StaleRefError, dismissOverlays } from './drivers/snapshot.js';

// Brain (LLM decision engine)
export { Brain } from './brain/index.js';
export type { BrainDecision, QualityEvaluation } from './brain/index.js';

// Agent runner (core observe -> decide -> execute loop)
export { AgentRunner, runAgent } from './runner.js';
export type { RunnerOptions } from './runner.js';

// Test runner (suite orchestration, verification, parallelism)
export { TestRunner } from './test-runner.js';
export type { TestRunnerOptions } from './test-runner.js';
export { generateReport, compareReports } from './test-report.js';
export type { ReportOptions } from './test-report.js';

// Preview verification
export { verifyPreview } from './preview.js';

// Design audit
export { DesignAuditor, generateDesignAuditReport } from './design-audit.js';

// Recovery
export {
  analyzeRecovery,
  detectStuck,
  detectSelectorFailures,
  detectLoadingState,
} from './recovery.js';

// Memory system
export { ProjectStore } from './memory/project-store.js';
export { AppKnowledge } from './memory/knowledge.js';
export type { Fact, KnowledgeData } from './memory/knowledge.js';
export { SelectorCache } from './memory/selectors.js';
export type { SelectorEntry } from './memory/selectors.js';
export { TrajectoryStore } from './memory/store.js';
export { TrajectoryAnalyzer } from './memory/analyzer.js';
export type { RunAnalysis, ActionPattern, GoalPattern, TurnWaste } from './memory/analyzer.js';

// Configuration
export { defineConfig, defineTests, loadConfig, mergeConfig, toAgentConfig } from './config.js';
export type { DriverConfig } from './config.js';

// JUnit reporter
export { generateJUnitXml } from './reporters/junit.js';

// Artifact pipeline
export type {
  Artifact,
  ArtifactSink,
  ArtifactType,
  ArtifactManifestEntry,
  ProgressEvent,
} from './artifacts/types.js';
export { FilesystemSink } from './artifacts/filesystem-sink.js';
export { CompositeSink } from './artifacts/composite-sink.js';
export { WebhookSink } from './artifacts/webhook-sink.js';
export type { WebhookSinkOptions, WebhookPayload } from './artifacts/webhook-sink.js';
