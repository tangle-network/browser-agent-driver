/**
 * Test Runner — dependency-aware orchestration with ground-truth verification.
 *
 * Sequential mode (default): reuses a single driver, resolves dependencies.
 * Parallel mode: spawns up to N concurrent workers, each with its own driver.
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import type {
  TestCase,
  TestResult,
  TestSuiteResult,
  CriterionResult,
  SuccessCriterion,
  AgentConfig,
  AgentResult,
  Turn,
} from './types.js';
import type { Driver } from './drivers/types.js';
import type { ArtifactSink, ProgressEvent } from './artifacts/types.js';
import { FilesystemSink } from './artifacts/filesystem-sink.js';
import { BrowserAgent } from './runner.js';
import { Brain } from './brain/index.js';
import { TrajectoryStore } from './memory/store.js';
import { TrajectoryAnalyzer, type RunAnalysis } from './memory/analyzer.js';
import type { ProjectStore } from './memory/project-store.js';
import { AppKnowledge } from './memory/knowledge.js';
import { RunRegistry } from './memory/run-registry.js';
import { generateReport } from './test-report.js';

const DEFAULT_MAX_TURNS = 30;

import { loadPricing, calculateCost } from './model-pricing.js';

interface RuntimeObservabilityOutcome {
  passed: boolean;
  verdict: string;
  durationMs: number;
  turnsUsed: number;
}

interface RuntimeObservabilityHandle {
  finalize(outcome?: RuntimeObservabilityOutcome): Promise<void>;
}

export interface TestRunnerOptions {
  /** Agent configuration (model, API key, vision, etc.) */
  config?: AgentConfig;
  /** Default per-test timeout in ms when a case omits timeoutMs */
  defaultTimeoutMs?: number;

  /** Single driver for sequential execution */
  driver?: Driver;
  /** Factory for creating isolated drivers (required for parallel execution) */
  driverFactory?: () => Promise<Driver>;

  /** Max concurrent test cases (default: 1 = sequential) */
  concurrency?: number;
  /** Stop suite on first failure */
  stopOnFailure?: boolean;

  /** Enable trajectory memory (loads/saves successful runs) */
  enableMemory?: boolean;
  /** Path to trajectory store directory */
  trajectoryStorePath?: string;

  /** Project memory store — enables knowledge, selectors, and domain-scoped trajectories */
  projectStore?: ProjectStore;

  /** Hints from previous run analysis — injected into each agent's context */
  feedbackHints?: string;

  /** Capture screenshot every N turns (0 = disabled) */
  screenshotInterval?: number;

  /** Called when a test case starts */
  onTestStart?: (tc: TestCase) => void;
  /** Called when a test case completes */
  onTestComplete?: (result: TestResult) => void;
  /** Called after each agent turn */
  onTurn?: (tc: TestCase, turn: Turn) => void;
  /**
   * Gen 32 — called at the top of every turn before observe(). Returns
   * a promise the runner awaits; used by the interrupt controller to
   * block while paused. Rejection triggers a clean abort.
   */
  beforeTurn?: (turn: number) => Promise<void>;

  /** Pluggable artifact storage — screenshots, video, reports flow through this */
  artifactSink?: ArtifactSink;
  /** Unified progress event stream for dashboards/CI/coordinators */
  onProgress?: (event: ProgressEvent) => void;
  /** Per-worker timeout in ms — stuck workers get force-terminated (default: none) */
  workerTimeoutMs?: number;
  /**
   * Resolved user extensions (loaded from bad.config.{js,mjs,ts} or via
   * --extension flags). Forwarded to every BrowserAgent instance the runner
   * spawns so onTurnEvent / mutateDecision / addRules fire on every test.
   */
  extensions?: import('./extensions/types.js').ResolvedExtensions;
  /**
   * Gen 29: rendered macro prompt block from skills/macros. Forwarded to
   * every BrowserAgent so macros are visible in the system prompt.
   */
  macroPromptBlock?: string;
  /**
   * Optional shared TurnEventBus. When set, every BrowserAgent uses the same
   * bus so a live SSE viewer or events.jsonl sink can observe an entire suite
   * from one subscription. When omitted, each agent gets its own no-op bus.
   */
  eventBus?: import('./runner/events.js').TurnEventBus;
}

interface RunTestOptions {
  signal?: AbortSignal;
}

function combineAbortSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((s): s is AbortSignal => !!s);
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];

  const controller = new AbortController();
  const onAbort = (event: Event) => {
    const target = event.target as AbortSignal;
    controller.abort(target.reason || 'Cancelled');
  };

  for (const signal of active) {
    if (signal.aborted) {
      controller.abort(signal.reason || 'Cancelled');
      return controller.signal;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  return controller.signal;
}

function getOrigin(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

export class TestRunner {
  private config: AgentConfig;
  private driver: Driver | undefined;
  private driverFactory: (() => Promise<Driver>) | undefined;
  private concurrency: number;
  private stopOnFailure: boolean;
  private store: TrajectoryStore | null;
  private projectStore?: ProjectStore;
  private runRegistry?: RunRegistry;
  private feedbackHints: string | undefined;
  private screenshotInterval: number;
  private analyzer: TrajectoryAnalyzer;
  private onTestStart?: (tc: TestCase) => void;
  private onTestComplete?: (result: TestResult) => void;
  private onTurn?: (tc: TestCase, turn: Turn) => void;
  private beforeTurn?: (turn: number) => Promise<void>;
  private artifactSink?: ArtifactSink;
  private onProgress?: (event: ProgressEvent) => void;
  private workerTimeoutMs?: number;
  private defaultTimeoutMs?: number;
  private pendingArtifactOps: Set<Promise<unknown>> = new Set();
  private extensions?: import('./extensions/types.js').ResolvedExtensions;
  private macroPromptBlock?: string;
  private eventBus?: import('./runner/events.js').TurnEventBus;
  /** Suite-level abort signal — wired up by runSuite, consumed by runTest */
  private suiteSignal?: AbortSignal;

  constructor(options: TestRunnerOptions) {
    if (!options.driver && !options.driverFactory) {
      throw new Error('TestRunnerOptions requires either driver or driverFactory');
    }
    this.config = options.config || {};
    this.driver = options.driver;
    this.driverFactory = options.driverFactory;
    this.concurrency = options.concurrency ?? 1;
    this.stopOnFailure = options.stopOnFailure ?? false;
    this.projectStore = options.projectStore;
    this.runRegistry = options.projectStore ? new RunRegistry(options.projectStore.getRoot()) : undefined;
    this.store = options.enableMemory
      ? new TrajectoryStore(options.trajectoryStorePath, {
        enableScoring: this.config.traceScoring === true,
        ttlDays: this.config.traceTtlDays ?? 30,
      })
      : null;
    // Auto-load hints from project store if available
    this.feedbackHints = options.feedbackHints ?? options.projectStore?.loadHints() ?? undefined;
    this.screenshotInterval = options.screenshotInterval ?? 0;
    this.analyzer = new TrajectoryAnalyzer();
    this.onTestStart = options.onTestStart;
    this.onTestComplete = options.onTestComplete;
    this.onTurn = options.onTurn;
    this.beforeTurn = options.beforeTurn;
    this.artifactSink = options.artifactSink;
    this.onProgress = options.onProgress;
    this.workerTimeoutMs = options.workerTimeoutMs;
    // Backward-compat: honor non-typed timeoutMs on config if explicitly set by library users.
    this.defaultTimeoutMs = options.defaultTimeoutMs
      ?? ((options.config as AgentConfig & { timeoutMs?: number } | undefined)?.timeoutMs);
    this.extensions = options.extensions;
    this.macroPromptBlock = options.macroPromptBlock;
    this.eventBus = options.eventBus;
  }

  /** Run a single test case */
  async runTest(testCase: TestCase, driver?: Driver, options?: RunTestOptions): Promise<TestResult> {
    const activeDriver = driver || this.driver;
    if (!activeDriver) {
      throw new Error('No driver available — provide driver or driverFactory');
    }

    const startedAt = new Date();
    const screenshots: { turn: number; base64: string }[] = [];
    this.onTestStart?.(testCase);
    this.onProgress?.({ type: 'test:start', testId: testCase.id, testName: testCase.name, workerId: 0 });

    // Run setup hook
    const page = activeDriver.getPage?.();
    const runtimeObservability = await this.startRuntimeObservability(testCase, page, activeDriver);
    let runtimeOutcome: RuntimeObservabilityOutcome | undefined;
    const runStartedAtMs = Date.now();
    let timeToFirstTurnMs: number | undefined;
    const observedTurns: Turn[] = [];
    const partialPhaseTimings: AgentResult['phaseTimings'] = {};
    if (testCase.setup && page) {
      await testCase.setup(page);
    }

    try {
      // Look up reference trajectory
      let referenceTrajectory: string | undefined;
      if (this.store) {
        const match = this.store.findBestMatch(testCase.goal, {
          origin: getOrigin(testCase.startUrl),
        });
        if (match) {
          referenceTrajectory = this.store.formatAsReference(match);
        }
      }

      // Build combined context: reference trajectory + feedback hints
      let combinedReference = referenceTrajectory;
      if (this.feedbackHints) {
        combinedReference = combinedReference
          ? `${combinedReference}\n\n${this.feedbackHints}`
          : this.feedbackHints;
      }

      // Per-test event bus. Wraps the suite-level live bus (when --live is
      // on) by forwarding every event, AND drives a per-test events.jsonl
      // sink so `bad view <run-dir>` can replay the streaming experience.
      // Each test gets its own bus so events from concurrent runs never
      // cross-contaminate the persistence layer.
      const { TurnEventBus: PerTestBus } = await import('./runner/events.js');
      const perTestBus = new PerTestBus();
      const fsSinkRef = this.artifactSink instanceof FilesystemSink ? this.artifactSink : undefined;
      perTestBus.subscribe((event) => {
        // Persist every event to <baseDir>/<testId>/events.jsonl. The sink
        // opens an append stream on first call and closes it when the test
        // completes (in the finally block below).
        fsSinkRef?.appendEvent(testCase.id, event);
        // Forward to the suite-level live bus so the SSE viewer sees it.
        this.eventBus?.emit(event);
      }, false);

      const runner = new BrowserAgent({
        driver: activeDriver,
        config: this.config,
        referenceTrajectory: combinedReference,
        projectStore: this.projectStore,
        runRegistry: this.runRegistry,
        ...(this.extensions ? { extensions: this.extensions } : {}),
        ...(this.macroPromptBlock ? { macroPromptBlock: this.macroPromptBlock } : {}),
        eventBus: perTestBus,
        ...(this.beforeTurn ? { beforeTurn: this.beforeTurn } : {}),
        onTurn: (turn) => {
          if (timeToFirstTurnMs === undefined) {
            timeToFirstTurnMs = Math.max(0, Date.now() - runStartedAtMs);
          }
          observedTurns.push(structuredClone(turn));
          this.onTurn?.(testCase, turn);
          this.onProgress?.({
            type: 'test:turn',
            testId: testCase.id,
            turn: turn.turn,
            action: turn.action.action,
            durationMs: turn.durationMs,
            tokensUsed: turn.tokensUsed,
            modelUsed: turn.modelUsed,
          });

          if (this.screenshotInterval > 0 && turn.turn % this.screenshotInterval === 0) {
            if (turn.state.screenshot) {
              screenshots.push({ turn: turn.turn, base64: turn.state.screenshot });

              // Emit screenshot through artifact sink
              if (this.artifactSink) {
                const buf = Buffer.from(turn.state.screenshot, 'base64');
                const pending = this.artifactSink.put({
                  type: 'screenshot',
                  testId: testCase.id,
                  name: `turn-${String(turn.turn).padStart(3, '0')}.jpg`,
                  data: buf,
                  contentType: 'image/jpeg',
                  metadata: { turn: String(turn.turn), action: turn.action.action },
                }).then(uri => {
                  this.onProgress?.({ type: 'test:artifact', testId: testCase.id, artifactType: 'screenshot', uri });
                }).catch(() => {}); // Best-effort
                this.trackArtifactOp(pending);
              }
            }
          }
        },
        onPhaseTiming: (phase, durationMs) => {
          if (phase === 'navigate') partialPhaseTimings.initialNavigateMs ??= durationMs;
          if (phase === 'observe') partialPhaseTimings.firstObserveMs ??= durationMs;
          if (phase === 'decide') partialPhaseTimings.firstDecideMs ??= durationMs;
          if (phase === 'execute') partialPhaseTimings.firstExecuteMs ??= durationMs;
        },
      });

      // Build goal with success description
      let goal = testCase.goal;
      if (testCase.successDescription) {
        goal += `\n\nSuccess criteria: ${testCase.successDescription}`;
      }

      // Run with timeout + abort signal (per-test, suite-level, and timeout)
      const timeoutMs = this.resolveTimeoutMs(testCase);
      const timeoutAbortController = timeoutMs && timeoutMs > 0 ? new AbortController() : undefined;
      const combinedSignal = combineAbortSignals([
        timeoutAbortController?.signal,
        options?.signal,
        this.suiteSignal,
      ]);

      const runPromise = runner.run({
        goal,
        startUrl: testCase.startUrl,
        allowedDomains: testCase.allowedDomains,
        maxTurns: testCase.maxTurns ?? DEFAULT_MAX_TURNS,
        signal: combinedSignal,
        sessionId: testCase.sessionId,
        parentRunId: testCase.parentRunId,
      });

      let agentResult: AgentResult;
      if (timeoutMs && timeoutMs > 0 && timeoutAbortController) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<AgentResult>((resolve) => {
          timer = setTimeout(() => {
            const timedOutBeforeFirstTurn = timeToFirstTurnMs === undefined;
            const reason = timedOutBeforeFirstTurn
              ? `Pre-first-turn timeout after ${timeoutMs}ms`
              : `Test timed out after ${timeoutMs}ms`;
            timeoutAbortController.abort(reason);
            resolve({
              success: false,
              reason,
              turns: [...observedTurns],
              totalMs: timeoutMs,
              phaseTimings: partialPhaseTimings,
              startupDiagnostics: timedOutBeforeFirstTurn
                ? {
                  firstTurnSeen: false,
                  zeroTurnFailureClass: 'pre_first_turn_timeout',
                  startupReason: reason,
                }
                : {
                  firstTurnSeen: true,
                  timeToFirstTurnMs,
                },
              wasteMetrics: {
                repeatedQueryCount: 0,
                verificationRejectionCount: 0,
                turnsAfterSufficientEvidence: 0,
                errorTurns: 0,
              },
            });
          }, timeoutMs);
        });
        agentResult = await Promise.race([runPromise, timeoutPromise])
          .finally(() => { if (timer) clearTimeout(timer); });
      } else {
        agentResult = await runPromise;
      }

      agentResult = attachStartupDiagnostics(agentResult, timeToFirstTurnMs);

      // Ground-truth verification
      // Default to agent outcome when no explicit criteria are provided.
      let verified = agentResult.success;
      let criteriaResults: CriterionResult[] | undefined;

      if (testCase.successCriteria?.length && page) {
        criteriaResults = await this.verifyCriteria(testCase.successCriteria, page);
        verified = agentResult.success && criteriaResults.every((c) => c.passed);
      }
      if (!agentResult.success) {
        verified = false;
      }

      // Save trajectory if memory enabled
      const tokensUsed = agentResult.turns.reduce((sum, t) => sum + (t.tokensUsed || 0), 0);
      const totalInputTokens = agentResult.turns.reduce((sum, t) => sum + (t.inputTokens || 0), 0);
      const totalOutputTokens = agentResult.turns.reduce((sum, t) => sum + (t.outputTokens || 0), 0);
      if (this.store) {
        this.store.save(
          testCase.goal,
          agentResult.turns,
          verified && agentResult.success,
          this.config.model || 'unknown',
          { origin: getOrigin(testCase.startUrl) },
        );
      }

      const endedAt = new Date();
      const verdict = this.buildVerdict(agentResult, verified, criteriaResults);

      // Calculate cost from LiteLLM's pricing database
      const modelName = this.config.model || 'gpt-5.4';
      const estimatedCostUsd = calculateCost(modelName, totalInputTokens, totalOutputTokens);

      const result: TestResult = {
        testCase,
        agentResult,
        agentSuccess: agentResult.success,
        verified,
        criteriaResults,
        verdict,
        turnsUsed: agentResult.turns.length,
        tokensUsed,
        inputTokens: totalInputTokens || undefined,
        outputTokens: totalOutputTokens || undefined,
        estimatedCostUsd: estimatedCostUsd || undefined,
        durationMs: endedAt.getTime() - startedAt.getTime(),
        phaseTimings: agentResult.phaseTimings,
        startupDiagnostics: agentResult.startupDiagnostics,
        wasteMetrics: agentResult.wasteMetrics,
        startedAt,
        endedAt,
        screenshots: screenshots.length > 0 ? screenshots : undefined,
        runtime: this.buildRuntimeConfig(),
      };

      // Emit video artifact if available.
      //
      // Playwright finalizes the recording on context close, NOT on
      // `page.video().path()`. If we read the file before the caller closes
      // the context, we get a 0-byte placeholder. The canonical fix is
      // `video.saveAs(target)` which waits for the video to finalize.
      //
      // We DO close the page (not the whole context — the caller owns the
      // context lifecycle) so that the video stream gets a chance to flush
      // before saveAs is called. saveAs then awaits the actual finalization.
      if (this.artifactSink && page) {
        try {
          const video = page.video?.();
          if (video) {
            const os = await import('node:os');
            const fs = await import('node:fs');
            const pathMod = await import('node:path');
            const tmpFile = pathMod.join(os.tmpdir(), `bad-rec-${testCase.id}-${Date.now()}.webm`);

            // Close the page first so Playwright flushes the video stream.
            // We don't close the context — that's the caller's job.
            try {
              await page.close();
            } catch {
              /* page may be already closing */
            }

            // saveAs() resolves once the video file is written. This is the
            // canonical Playwright API for waiting on a finalized recording.
            let saved = false;
            try {
              await video.saveAs(tmpFile);
              saved = true;
            } catch {
              /* video may not be available — fall through to existence check */
            }

            if (saved && fs.existsSync(tmpFile)) {
              const stats = fs.statSync(tmpFile);
              if (stats.size > 0) {
                const videoData = fs.readFileSync(tmpFile);
                const uri = await this.artifactSink.put({
                  type: 'video',
                  testId: testCase.id,
                  name: 'recording.webm',
                  data: videoData,
                  contentType: 'video/webm',
                  metadata: { durationMs: String(result.durationMs), turnsUsed: String(result.turnsUsed) },
                });
                this.onProgress?.({ type: 'test:artifact', testId: testCase.id, artifactType: 'video', uri });
              }
              try { fs.unlinkSync(tmpFile); } catch { /* best-effort cleanup */ }
            }
          }
        } catch {
          // Video capture is best-effort
        }
      }

      // Update run manifest with artifact paths from the sink
      if (this.runRegistry && this.artifactSink) {
        const manifest = this.artifactSink.getManifest()
        const testArtifacts = manifest
          .filter(e => e.testId === testCase.id)
          .map(e => e.uri)
        if (testArtifacts.length > 0) {
          // Find the matching run manifest by sessionId or recent domain runs
          const runs = this.runRegistry.listRuns({
            sessionId: testCase.sessionId,
            status: 'completed',
            limit: 1,
          })
          if (runs.length > 0) {
            this.runRegistry.updateRun(runs[0].runId, { artifactPaths: testArtifacts })
          }
        }
      }

      this.onTestComplete?.(result);
      this.onProgress?.({
        type: 'test:complete',
        testId: testCase.id,
        passed: result.verified && result.agentSuccess,
        verdict: result.verdict,
        durationMs: result.durationMs,
        turnsUsed: result.turnsUsed,
        tokensUsed: result.tokensUsed,
        estimatedCostUsd: result.estimatedCostUsd,
      });
      runtimeOutcome = {
        passed: result.verified && result.agentSuccess,
        verdict: result.verdict,
        durationMs: result.durationMs,
        turnsUsed: result.turnsUsed,
      };
      return result;
    } finally {
      // Flush the per-test events.jsonl stream so the file is complete on
      // disk before any reader (replay viewer, post-run analyzer) opens it.
      // No-op when there's no FilesystemSink or no events were written.
      if (this.artifactSink instanceof FilesystemSink) {
        await this.artifactSink.closeEventStream(testCase.id).catch(() => undefined);
      }
      await runtimeObservability?.finalize(runtimeOutcome).catch((err) => {
        if (this.config.debug) {
          console.log(`[TestRunner] Observability finalize failed for ${testCase.id}: ${err instanceof Error ? err.message : err}`);
        }
      });
      if (testCase.teardown && page) {
        await testCase.teardown(page).catch((err) => {
          if (this.config.debug) {
            console.log(`[TestRunner] Teardown failed for ${testCase.id}: ${err instanceof Error ? err.message : err}`);
          }
        });
      }
    }
  }

  /** Run a suite of test cases with dependency resolution and optional parallelism */
  async runSuite(cases: TestCase[], options?: { signal?: AbortSignal }): Promise<TestSuiteResult> {
    // Pre-load pricing database (async fetch, cached 24h)
    loadPricing().catch(() => {});
    this.onProgress?.({ type: 'suite:start', totalTests: cases.length, concurrency: this.concurrency });
    // Stash the suite-level signal so runTest invocations can pick it up
    // without changing every internal call site.
    this.suiteSignal = options?.signal;

    let result: TestSuiteResult;
    if (this.concurrency > 1 && this.driverFactory) {
      result = await this.runParallel(cases);
    } else {
      result = await this.runSequential(cases);
    }

    // Emit reports as artifacts
    if (this.artifactSink) {
      try {
        await this.flushArtifactOps();
        const jsonReport = generateReport(result, { format: 'json' });
        const jsonUri = await this.artifactSink.put({
          type: 'report-json',
          testId: 'suite',
          name: 'report.json',
          data: Buffer.from(jsonReport, 'utf-8'),
          contentType: 'application/json',
          metadata: { model: result.model, timestamp: result.timestamp },
        });
        this.onProgress?.({ type: 'test:artifact', testId: 'suite', artifactType: 'report-json', uri: jsonUri });

        const mdReport = generateReport(result, { format: 'markdown', includeTurns: true });
        const mdUri = await this.artifactSink.put({
          type: 'report-md',
          testId: 'suite',
          name: 'report.md',
          data: Buffer.from(mdReport, 'utf-8'),
          contentType: 'text/markdown',
        });
        this.onProgress?.({ type: 'test:artifact', testId: 'suite', artifactType: 'report-md', uri: mdUri });
      } catch {
        // Report emission is best-effort
      }
    }

    // Post-suite memory operations
    if (this.projectStore) {
      this.projectStore.saveRunSummary(result);

      // Generate and save optimization hints
      const analysis = this.analyzer.analyze(result);
      const hints = this.analyzer.generateHints(analysis);
      if (hints) {
        this.projectStore.saveHints(hints);
      }

      // Extract knowledge from successful runs (async, best-effort)
      await this.extractAndSaveKnowledge(result).catch((err: unknown) => {
        if (this.config.debug) {
          console.log(`[TestRunner] Knowledge extraction failed: ${err instanceof Error ? err.message : err}`);
        }
      });
    }

    // Finalize artifact sink (writes manifest, flushes)
    let manifestUri: string | undefined;
    if (this.artifactSink) {
      try {
        const manifest = this.artifactSink.getManifest();
        manifestUri = await this.artifactSink.put({
          type: 'report-json',
          testId: 'suite',
          name: 'manifest.json',
          data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'),
          contentType: 'application/json',
        });
        await this.artifactSink.close?.();
      } catch {
        // Best-effort
      }
    }

    const totalCostUsd = result.results.reduce((sum, r) => sum + (r.estimatedCostUsd || 0), 0);
    this.onProgress?.({
      type: 'suite:complete',
      passed: result.summary.passed,
      failed: result.summary.failed,
      skipped: result.summary.skipped,
      totalMs: result.summary.totalDurationMs,
      totalCostUsd: totalCostUsd || undefined,
      manifestUri,
    });

    return result;
  }

  /** Analyze a completed suite run and return structured findings */
  analyzeSuite(suite: TestSuiteResult): RunAnalysis {
    return this.analyzer.analyze(suite);
  }

  /** Generate optimization hints from analysis — pass to feedbackHints on the next run */
  generateHints(analysis: RunAnalysis): string {
    return this.analyzer.generateHints(analysis);
  }

  // ── Sequential execution ──

  private async runSequential(cases: TestCase[]): Promise<TestSuiteResult> {
    const sorted = [...cases].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
    const results: TestResult[] = [];

    for (const tc of sorted) {
      // Check dependencies
      const skipReason = this.checkDependencies(tc, results);
      if (skipReason) {
        const skipped = this.makeSkippedResult(tc, skipReason);
        results.push(skipped);
        continue;
      }

      const result = await this.runTest(tc);
      results.push(result);

      if (!result.verified && this.stopOnFailure) break;
    }

    return this.buildSuiteResult(results);
  }

  // ── Parallel execution ──

  private async runParallel(cases: TestCase[]): Promise<TestSuiteResult> {
    const sorted = [...cases].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
    const knownCaseIds = new Set(sorted.map((c) => c.id));
    const results: TestResult[] = [];
    const completed = new Map<string, TestResult>();
    const pending = new Set(sorted.map((c) => c.id));
    let stopped = false;
    let runningCount = 0;

    const tryDequeue = (): TestCase | null => {
      for (const tc of sorted) {
        if (!pending.has(tc.id)) continue;

        const missingDeps = (tc.dependsOn ?? []).filter((dep) => !knownCaseIds.has(dep));
        if (missingDeps.length > 0) {
          pending.delete(tc.id);
          const skipped = this.makeSkippedResult(tc, `Dependencies not found: ${missingDeps.join(', ')}`);
          completed.set(tc.id, skipped);
          results.push(skipped);
          return tryDequeue();
        }

        // Check if dependencies are met
        if (tc.dependsOn?.length) {
          const unmet = tc.dependsOn.some((dep) => {
            const depResult = completed.get(dep);
            return !depResult || !depResult.verified;
          });
          // If a dependency failed, skip this case
          const depFailed = tc.dependsOn.some((dep) => {
            const depResult = completed.get(dep);
            return depResult && !depResult.verified;
          });
          if (depFailed) {
            const failedDeps = tc.dependsOn.filter(dep => {
              const r = completed.get(dep);
              return r && !r.verified;
            });
            pending.delete(tc.id);
            const skipped = this.makeSkippedResult(tc, `Dependencies failed: ${failedDeps.join(', ')}`);
            completed.set(tc.id, skipped);
            results.push(skipped);
            return tryDequeue(); // Try next
          }
          if (unmet) continue; // Dependencies not yet resolved, try another
        }

        pending.delete(tc.id);
        return tc;
      }
      return null;
    };

    const markUnresolvablePending = (): void => {
      if (pending.size === 0) return;

      for (const tc of sorted) {
        if (!pending.has(tc.id)) continue;
        pending.delete(tc.id);

        const unresolvedDeps = (tc.dependsOn ?? []).filter((dep) => {
          const depResult = completed.get(dep);
          if (!depResult) return true;
          return !depResult.verified;
        });
        const reason = unresolvedDeps.length > 0
          ? `Unresolvable dependencies (cycle or unmet): ${unresolvedDeps.join(', ')}`
          : 'Unresolvable dependency graph (no runnable tests remain)';
        const skipped = this.makeSkippedResult(tc, reason);
        completed.set(tc.id, skipped);
        results.push(skipped);
      }
    };

    const worker = async (): Promise<void> => {
      while (!stopped) {
        const tc = tryDequeue();
        if (!tc) {
          if (pending.size === 0) return;
          if (runningCount === 0) {
            markUnresolvablePending();
            continue;
          }
          // Wait for dependencies to resolve
          await new Promise((r) => setTimeout(r, 100));
          continue;
        }

        runningCount += 1;
        const driver = await this.driverFactory!();
        try {
          let result: TestResult;
          if (this.workerTimeoutMs) {
            const workerAbortController = new AbortController();
            const runPromise = this.runTest(tc, driver, { signal: workerAbortController.signal });
            let timeout: ReturnType<typeof setTimeout> | undefined;
            const timeoutPromise = new Promise<TestResult>((resolve) => {
              timeout = setTimeout(() => {
                workerAbortController.abort(`Worker timed out after ${this.workerTimeoutMs}ms`);
                resolve(this.makeSkippedResult(tc, `Worker timed out after ${this.workerTimeoutMs}ms`));
              }, this.workerTimeoutMs);
            });
            try {
              result = await Promise.race([runPromise, timeoutPromise]);
              if (result.skipped) {
                // Keep background promise from surfacing unhandled rejections.
                runPromise.catch(() => {});
              }
            } finally {
              if (timeout) clearTimeout(timeout);
            }
          } else {
            result = await this.runTest(tc, driver);
          }
          completed.set(tc.id, result);
          results.push(result);

          if (!result.verified && this.stopOnFailure) {
            if (!stopped) {
              stopped = true;
              for (const remainingId of [...pending]) {
                const remaining = sorted.find((c) => c.id === remainingId);
                if (!remaining) continue;
                pending.delete(remaining.id);
                const skipped = this.makeSkippedResult(remaining, `Stopped after failure in ${tc.id}`);
                completed.set(remaining.id, skipped);
                results.push(skipped);
              }
            }
          }
        } finally {
          runningCount = Math.max(0, runningCount - 1);
          await driver.close?.();
        }
      }
    };

    // Spawn workers
    const workers = Array.from(
      { length: Math.min(this.concurrency, cases.length) },
      () => worker(),
    );
    await Promise.all(workers);

    // Preserve original sort order in results
    const ordered = sorted.map((tc) =>
      results.find((r) => r.testCase.id === tc.id) || this.makeSkippedResult(tc, 'Not reached'),
    );

    return this.buildSuiteResult(ordered);
  }

  // ── Verification ──

  private async verifyCriteria(
    criteria: SuccessCriterion[],
    page: Page,
  ): Promise<CriterionResult[]> {
    const results: CriterionResult[] = [];

    for (const criterion of criteria) {
      try {
        results.push(await this.verifySingleCriterion(criterion, page));
      } catch (err) {
        results.push({
          criterion,
          passed: false,
          detail: `Error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    return results;
  }

  private async verifySingleCriterion(
    criterion: SuccessCriterion,
    page: Page,
  ): Promise<CriterionResult> {
    switch (criterion.type) {
      case 'url-contains': {
        const url = page.url();
        const passed = url.includes(criterion.value || '');
        return {
          criterion,
          passed,
          detail: passed ? undefined : `URL "${url}" does not contain "${criterion.value}"`,
        };
      }

      case 'url-matches': {
        const url = page.url();
        const regex = new RegExp(criterion.value || '');
        const passed = regex.test(url);
        return {
          criterion,
          passed,
          detail: passed ? undefined : `URL "${url}" does not match pattern "${criterion.value}"`,
        };
      }

      case 'element-visible': {
        if (!criterion.selector) {
          return { criterion, passed: false, detail: 'No selector provided' };
        }
        const visible = await page
          .locator(criterion.selector)
          .first()
          .isVisible({ timeout: 5000 })
          .catch(() => false);
        return {
          criterion,
          passed: visible,
          detail: visible ? undefined : `Element "${criterion.selector}" is not visible`,
        };
      }

      case 'element-text': {
        if (!criterion.selector) {
          return { criterion, passed: false, detail: 'No selector provided' };
        }
        const text = await page
          .locator(criterion.selector)
          .first()
          .textContent({ timeout: 5000 })
          .catch(() => '');
        const passed = (text || '').includes(criterion.value || '');
        return {
          criterion,
          passed,
          detail: passed
            ? undefined
            : `Element "${criterion.selector}" text "${text}" does not contain "${criterion.value}"`,
        };
      }

      case 'element-count': {
        if (!criterion.selector) {
          return { criterion, passed: false, detail: 'No selector provided' };
        }
        const count = await page.locator(criterion.selector).count();
        const expected = parseInt(criterion.value || '0', 10);
        const passed = count >= expected;
        return {
          criterion,
          passed,
          detail: passed
            ? undefined
            : `Found ${count} elements matching "${criterion.selector}", expected >= ${expected}`,
        };
      }

      case 'custom': {
        if (!criterion.check) {
          return { criterion, passed: false, detail: 'No check function provided' };
        }
        const passed = await criterion.check(page);
        return {
          criterion,
          passed,
          detail: passed ? undefined : `Custom check failed: ${criterion.description || 'unknown'}`,
        };
      }

      default:
        return { criterion, passed: false, detail: `Unknown criterion type: ${criterion.type}` };
    }
  }

  // ── Helpers ──

  private checkDependencies(tc: TestCase, completed: TestResult[]): string | undefined {
    if (!tc.dependsOn?.length) return undefined;

    const unmet = tc.dependsOn.filter((dep) => {
      const depResult = completed.find((r) => r.testCase.id === dep);
      return !depResult || !depResult.verified;
    });

    if (unmet.length > 0) {
      return `Dependencies not met: ${unmet.join(', ')}`;
    }
    return undefined;
  }

  private resolveTimeoutMs(testCase: TestCase): number | undefined {
    const base = testCase.timeoutMs ?? this.defaultTimeoutMs;
    // Gen 26: vision mode gets 5× timeout (600s for 120s base cases).
    // The cost cap (200k tokens) is the real safety net. Timeout was
    // artificially killing 7 tasks that were making progress.
    if (base && (this.config?.observationMode === 'vision' || this.config?.observationMode === 'hybrid')) {
      return Math.round(base * 5);
    }
    return base;
  }

  private makeSkippedResult(tc: TestCase, reason: string): TestResult {
    const now = new Date();
    return {
      testCase: tc,
      agentResult: { success: false, reason, turns: [], totalMs: 0 },
      agentSuccess: false,
      verified: false,
      verdict: `Skipped: ${reason}`,
      turnsUsed: 0,
      tokensUsed: 0,
      durationMs: 0,
      phaseTimings: {},
      startupDiagnostics: {
        firstTurnSeen: false,
        zeroTurnFailureClass: 'unknown',
        startupReason: reason,
      },
      wasteMetrics: {
        repeatedQueryCount: 0,
        verificationRejectionCount: 0,
        turnsAfterSufficientEvidence: 0,
        errorTurns: 0,
      },
      startedAt: now,
      endedAt: now,
      skipped: true,
      skipReason: reason,
      runtime: this.buildRuntimeConfig(),
    };
  }

  private buildVerdict(
    agentResult: AgentResult,
    verified: boolean,
    criteriaResults?: CriterionResult[],
  ): string {
    if (verified && agentResult.success) {
      return agentResult.result || 'Goal achieved';
    }
    if (!agentResult.success) {
      return agentResult.reason || 'Agent failed';
    }
    // Agent reported success but verification failed
    const failedCriteria = criteriaResults
      ?.filter((c) => !c.passed)
      .map((c) => c.detail || c.criterion.description || c.criterion.type)
      .join('; ');
    return `Verification failed: ${failedCriteria || 'unknown criteria'}`;
  }

  /**
   * Extract knowledge from successful test runs and merge into domain knowledge.
   * Uses the Brain's extractKnowledge method to analyze trajectories.
   */
  private async extractAndSaveKnowledge(suite: TestSuiteResult): Promise<void> {
    if (!this.projectStore) return;

    const successfulResults = suite.results.filter(r => r.verified && !r.skipped);
    if (successfulResults.length === 0) return;

    const brain = new Brain(this.config);

    for (const result of successfulResults) {
      const startUrl = result.testCase.startUrl;
      if (!startUrl) continue;

      // Format trajectory for extraction
      const trajectoryText = result.agentResult.turns
        .map((t, i) => {
          const action = JSON.stringify(t.action);
          const verified = t.verified ? ' [verified]' : '';
          return `${i + 1}. URL: ${t.state.url} → ${action}${verified}`;
        })
        .join('\n');

      const facts = await brain.extractKnowledge(trajectoryText, startUrl);
      if (facts.length === 0) continue;

      // Merge into domain knowledge
      const knowledge = new AppKnowledge(
        this.projectStore.getKnowledgePath(startUrl),
        startUrl,
      );
      knowledge.recordFacts(facts);
      knowledge.save();

      if (this.config.debug) {
        console.log(`[TestRunner] Extracted ${facts.length} facts for ${startUrl}`);
      }
    }
  }

  private buildSuiteResult(results: TestResult[]): TestSuiteResult {
    const nonSkipped = results.filter((r) => !r.skipped);
    const durations = nonSkipped.map((r) => r.durationMs).sort((a, b) => a - b);
    const passed = nonSkipped.filter((r) => r.verified && r.agentSuccess).length;

    return {
      model: this.config.model || 'unknown',
      runtime: this.buildRuntimeConfig(),
      timestamp: new Date().toISOString(),
      results,
      summary: {
        total: results.length,
        passed,
        failed: nonSkipped.length - passed,
        skipped: results.length - nonSkipped.length,
        passRate: nonSkipped.length > 0 ? passed / nonSkipped.length : 0,
        avgTurns: avg(nonSkipped.map((r) => r.turnsUsed)),
        avgTokens: avg(nonSkipped.map((r) => r.tokensUsed)),
        avgDurationMs: avg(durations),
        p50DurationMs: percentile(durations, 0.5),
        p95DurationMs: percentile(durations, 0.95),
        totalDurationMs: durations.reduce((sum, d) => sum + d, 0),
      },
    };
  }

  private buildRuntimeConfig(): import('./types.js').RunRuntimeConfig {
    return {
      provider: this.config.provider || 'openai',
      model: this.config.model || 'unknown',
      ...(this.config.sandboxBackendType ? { sandboxBackendType: this.config.sandboxBackendType } : {}),
      ...(this.config.sandboxBackendProfile ? { sandboxBackendProfile: this.config.sandboxBackendProfile } : {}),
      ...(this.config.sandboxBackendProvider ? { sandboxBackendProvider: this.config.sandboxBackendProvider } : {}),
    };
  }

  private trackArtifactOp(p: Promise<unknown>): void {
    this.pendingArtifactOps.add(p);
    p.finally(() => {
      this.pendingArtifactOps.delete(p);
    }).catch(() => {});
  }

  private async flushArtifactOps(): Promise<void> {
    if (this.pendingArtifactOps.size === 0) return;
    await Promise.allSettled([...this.pendingArtifactOps]);
  }

  private async startRuntimeObservability(testCase: TestCase, page?: Page, driver?: Driver): Promise<RuntimeObservabilityHandle | null> {
    const config = this.config.observability;
    if (config?.enabled === false || !page || typeof (page as Page & { on?: unknown }).on !== 'function') {
      return null;
    }

    const captureConsole = config?.captureConsole !== false;
    const captureNetwork = config?.captureNetwork !== false;
    const tracePolicy = config?.tracePolicy ?? 'on-failure';
    const maxConsoleEntries = config?.maxConsoleEntries ?? 200;
    const maxNetworkEntries = config?.maxNetworkEntries ?? 200;
    const observabilityStartedAt = new Date().toISOString();

    const consoleEntries: Array<Record<string, string>> = [];
    const pageErrors: Array<Record<string, string>> = [];
    const requestFailures: Array<Record<string, string>> = [];
    const responseErrors: Array<Record<string, string>> = [];

    const pushLimited = (target: Array<Record<string, string>>, entry: Record<string, string>, limit: number) => {
      if (target.length >= limit) return;
      target.push(entry);
    };

    const onConsole = (msg: { type(): string; text(): string; location(): { url?: string; lineNumber?: number; columnNumber?: number } }) => {
      const level = msg.type();
      if (!['warning', 'error', 'assert'].includes(level)) return;
      const location = msg.location();
      pushLimited(consoleEntries, {
        level,
        text: msg.text(),
        url: location.url || '',
        line: String(location.lineNumber ?? ''),
        column: String(location.columnNumber ?? ''),
      }, maxConsoleEntries);
    };

    const onPageError = (err: Error) => {
      pushLimited(pageErrors, {
        message: err.message,
        stack: err.stack || '',
      }, maxConsoleEntries);
    };

    const onRequestFailed = (request: {
      url(): string;
      method(): string;
      resourceType(): string;
      failure(): { errorText?: string } | null;
    }) => {
      pushLimited(requestFailures, {
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        errorText: request.failure()?.errorText || '',
      }, maxNetworkEntries);
    };

    const onResponse = (response: {
      url(): string;
      status(): number;
      statusText(): string;
      request(): { method(): string; resourceType(): string };
    }) => {
      const status = response.status();
      if (status < 400) return;
      const request = response.request();
      pushLimited(responseErrors, {
        url: response.url(),
        status: String(status),
        statusText: response.statusText(),
        method: request.method(),
        resourceType: request.resourceType(),
      }, maxNetworkEntries);
    };

    if (captureConsole) {
      page.on('console', onConsole);
      page.on('pageerror', onPageError);
    }
    if (captureNetwork) {
      page.on('requestfailed', onRequestFailed);
      page.on('response', onResponse);
    }

    const context = page.context?.();
    let traceStarted = false;
    if (tracePolicy !== 'off' && context?.tracing?.start) {
      try {
        await context.tracing.start({ screenshots: true, snapshots: true });
        traceStarted = true;
      } catch {
        traceStarted = false;
      }
    }

    return {
      finalize: async (outcome?: RuntimeObservabilityOutcome) => {
        if (captureConsole) {
          if (typeof (page as Page & { off?: unknown }).off === 'function') {
            page.off('console', onConsole);
            page.off('pageerror', onPageError);
          }
        }
        if (captureNetwork) {
          if (typeof (page as Page & { off?: unknown }).off === 'function') {
            page.off('requestfailed', onRequestFailed);
            page.off('response', onResponse);
          }
        }

        let traceCaptured = false;
        let traceArtifactUri = '';
        let traceError = '';

        if (traceStarted && context?.tracing?.stop) {
          const shouldPersistTrace =
            tracePolicy === 'always' || (tracePolicy === 'on-failure' && outcome?.passed === false) || outcome === undefined;
          try {
            if (shouldPersistTrace) {
              const tracePath = join(tmpdir(), `abd-trace-${Date.now()}-${sanitizeArtifactId(testCase.id)}.zip`);
              await context.tracing.stop({ path: tracePath });
              if (this.artifactSink && existsSync(tracePath)) {
                const data = readFileSync(tracePath);
                if (data.length > 0) {
                  traceCaptured = true;
                  traceArtifactUri = await this.artifactSink.put({
                    type: 'trace',
                    testId: testCase.id,
                    name: 'trace.zip',
                    data,
                    contentType: 'application/zip',
                    metadata: {
                      policy: tracePolicy,
                      passed: String(outcome?.passed ?? false),
                    },
                  });
                  this.onProgress?.({ type: 'test:artifact', testId: testCase.id, artifactType: 'trace', uri: traceArtifactUri });
                }
                unlinkSync(tracePath);
              }
            } else {
              await context.tracing.stop();
            }
          } catch (err) {
            traceError = err instanceof Error ? err.message : String(err);
          }
        }

        if (!this.artifactSink) return;
        const driverDiagnostics = driver?.getDiagnostics?.();
        const runtimeLog = {
          startedAt: observabilityStartedAt,
          finishedAt: new Date().toISOString(),
          tracePolicy,
          traceCaptured,
          traceArtifactUri,
          traceError,
          outcome: outcome
            ? {
                passed: outcome.passed,
                verdict: outcome.verdict,
                durationMs: outcome.durationMs,
                turnsUsed: outcome.turnsUsed,
              }
            : null,
          console: consoleEntries,
          pageErrors,
          requestFailures,
          responseErrors,
          driverDiagnostics: driverDiagnostics ?? null,
        };

        const uri = await this.artifactSink.put({
          type: 'runtime-log',
          testId: testCase.id,
          name: 'runtime-log.json',
          data: Buffer.from(JSON.stringify(runtimeLog, null, 2), 'utf-8'),
          contentType: 'application/json',
          metadata: {
            consoleEntries: String(consoleEntries.length),
            pageErrors: String(pageErrors.length),
            requestFailures: String(requestFailures.length),
            responseErrors: String(responseErrors.length),
            traceCaptured: String(traceCaptured),
          },
        });
        this.onProgress?.({ type: 'test:artifact', testId: testCase.id, artifactType: 'runtime-log', uri });
      },
    };
  }
}

function attachStartupDiagnostics(agentResult: AgentResult, timeToFirstTurnMs?: number): AgentResult {
  if (agentResult.startupDiagnostics) return agentResult;

  if (typeof timeToFirstTurnMs === 'number') {
    return {
      ...agentResult,
      startupDiagnostics: {
        firstTurnSeen: true,
        timeToFirstTurnMs,
      },
    };
  }

  if ((agentResult.turns?.length ?? 0) > 0) {
    return {
      ...agentResult,
      startupDiagnostics: {
        firstTurnSeen: true,
      },
    };
  }

  return {
    ...agentResult,
    startupDiagnostics: {
      firstTurnSeen: false,
      zeroTurnFailureClass: classifyZeroTurnFailure(agentResult.reason),
      startupReason: agentResult.reason,
    },
  };
}

function classifyZeroTurnFailure(reasonRaw?: string): 'pre_first_turn_timeout' | 'provider_or_credentials' | 'runner_startup_error' | 'unknown' {
  const reason = String(reasonRaw || '').toLowerCase();
  if (!reason) return 'unknown';
  if (/pre-first-turn timeout|startup timeout/.test(reason)) return 'pre_first_turn_timeout';
  if (/incorrect api key|authorization failed|rate limit|llm|api key/.test(reason)) return 'provider_or_credentials';
  return 'runner_startup_error';
}

function sanitizeArtifactId(value: string): string {
  return String(value || 'test').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 64) || 'test';
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}
