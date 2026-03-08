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
  ObservabilityConfig,
  MicroPlanConfig,
  SupervisorConfig,
  SupervisorSignal,
  SupervisorDirective,
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
export type { Driver, ActionResult, ResourceBlockingOptions } from './drivers/types.js';
export { PlaywrightDriver } from './drivers/playwright.js';
export type { PlaywrightDriverOptions, ObserveTiming } from './drivers/playwright.js';
export { AriaSnapshotHelper, StaleRefError, dismissOverlays, stableHash, INTERACTIVE_ROLES } from './drivers/snapshot.js';
export type { ParsedElement, SnapshotDiff } from './drivers/snapshot.js';
export { ANALYTICS_PATTERNS, IMAGE_PATTERNS, MEDIA_PATTERNS } from './drivers/block-patterns.js';
export { buildCdpSnapshot } from './drivers/cdp-snapshot.js';
export type { CdpSnapshotResult } from './drivers/cdp-snapshot.js';
export { getPageMetadata } from './drivers/cdp-page-state.js';
export type { PageMetadata } from './drivers/cdp-page-state.js';

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

// Model pricing (LiteLLM-backed cost calculation)
export { loadPricing, calculateCost, getModelPricing } from './model-pricing.js';
export type { ModelPricing } from './model-pricing.js';

// Preview verification
export { verifyPreview } from './preview.js';

// Design audit
export { DesignAuditor, generateDesignAuditReport } from './design-audit.js';

// Recovery
export {
  analyzeRecovery,
  detectBlockingModal,
  detectStuck,
  detectSelectorFailures,
  detectLoadingState,
  parseSnapshotElements,
} from './recovery.js';

// Supervisor
export { detectSupervisorSignal, formatSupervisorSignal } from './supervisor/policy.js';
export { requestSupervisorDirective } from './supervisor/critic.js';

// Memory system
export { ProjectStore } from './memory/project-store.js';
export { AppKnowledge } from './memory/knowledge.js';
export type { Fact, KnowledgeData } from './memory/knowledge.js';
export { SelectorCache } from './memory/selectors.js';
export type { SelectorEntry } from './memory/selectors.js';
export { TrajectoryStore } from './memory/store.js';
export type { TrajectoryStoreOptions } from './memory/store.js';
export { TrajectoryAnalyzer } from './memory/analyzer.js';
export type { RunAnalysis, ActionPattern, GoalPattern, TurnWaste } from './memory/analyzer.js';

// Configuration
export { defineConfig, defineTests, loadConfig, mergeConfig, toAgentConfig } from './config.js';
export type { DriverConfig } from './config.js';
export { buildBrowserLaunchPlan } from './browser-launch.js';
export type { BrowserLaunchPlan, BuildBrowserLaunchPlanOptions } from './browser-launch.js';

// Wallet automation helpers
export {
  DEFAULT_WALLET_ACTION_SELECTORS,
  DEFAULT_CONNECT_SELECTORS,
  DEFAULT_CONNECTOR_SELECTORS,
  DEFAULT_PROMPT_PATHS,
  resolveWalletExtensionId,
  startWalletAutoApprover,
  settleWalletPrompts,
  runWalletOriginPreflight,
  runWalletPreflight,
} from './wallet/automation.js';
export type {
  WalletAutomationOptions,
  WalletPreflightChainTarget,
  WalletPreflightOptions,
  WalletOriginPreflightResult,
  WalletPreflightResult,
} from './wallet/automation.js';

// JUnit reporter
export { generateJUnitXml } from './reporters/junit.js';

// Multi-actor sessions (coordinated multi-user browser testing)
export { MultiActorSession, Actor } from './multi-actor.js';
export type { ActorConfig, MultiActorSessionConfig } from './multi-actor.js';

// Persona directives
export { PERSONA_IDS, getPersonaDirective, withPersonaDirective, isPersonaId, listPersonaIds } from './personas.js';
export type { PersonaId, PersonaDirectiveInput } from './personas.js';

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

// Payload formatters (for WebhookSink.formatPayload)
export { slackFormatter } from './formatters/slack.js';
