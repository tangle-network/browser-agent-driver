/**
 * Test Runner — dependency-aware orchestration with ground-truth verification.
 *
 * Sequential mode (default): reuses a single driver, resolves dependencies.
 * Parallel mode: spawns up to N concurrent workers, each with its own driver.
 */

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
import { AgentRunner } from './runner.js';
import { Brain } from './brain/index.js';
import { TrajectoryStore } from './memory/store.js';
import { TrajectoryAnalyzer, type RunAnalysis } from './memory/analyzer.js';
import type { ProjectStore } from './memory/project-store.js';
import { AppKnowledge } from './memory/knowledge.js';
import { generateReport } from './test-report.js';

const DEFAULT_MAX_TURNS = 30;

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

  /** Pluggable artifact storage — screenshots, video, reports flow through this */
  artifactSink?: ArtifactSink;
  /** Unified progress event stream for dashboards/CI/coordinators */
  onProgress?: (event: ProgressEvent) => void;
  /** Per-worker timeout in ms — stuck workers get force-terminated (default: none) */
  workerTimeoutMs?: number;
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
  private feedbackHints: string | undefined;
  private screenshotInterval: number;
  private analyzer: TrajectoryAnalyzer;
  private onTestStart?: (tc: TestCase) => void;
  private onTestComplete?: (result: TestResult) => void;
  private onTurn?: (tc: TestCase, turn: Turn) => void;
  private artifactSink?: ArtifactSink;
  private onProgress?: (event: ProgressEvent) => void;
  private workerTimeoutMs?: number;
  private defaultTimeoutMs?: number;
  private pendingArtifactOps: Set<Promise<unknown>> = new Set();

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
    this.artifactSink = options.artifactSink;
    this.onProgress = options.onProgress;
    this.workerTimeoutMs = options.workerTimeoutMs;
    // Backward-compat: honor non-typed timeoutMs on config if explicitly set by library users.
    this.defaultTimeoutMs = options.defaultTimeoutMs
      ?? ((options.config as AgentConfig & { timeoutMs?: number } | undefined)?.timeoutMs);
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

      const runner = new AgentRunner({
        driver: activeDriver,
        config: this.config,
        referenceTrajectory: combinedReference,
        projectStore: this.projectStore,
        onTurn: (turn) => {
          this.onTurn?.(testCase, turn);
          this.onProgress?.({
            type: 'test:turn',
            testId: testCase.id,
            turn: turn.turn,
            action: turn.action.action,
            durationMs: turn.durationMs,
            tokensUsed: turn.tokensUsed,
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
      });

      // Build goal with success description
      let goal = testCase.goal;
      if (testCase.successDescription) {
        goal += `\n\nSuccess criteria: ${testCase.successDescription}`;
      }

      // Run with timeout + abort signal
      const timeoutMs = this.resolveTimeoutMs(testCase);
      const timeoutAbortController = timeoutMs && timeoutMs > 0 ? new AbortController() : undefined;
      const combinedSignal = combineAbortSignals([timeoutAbortController?.signal, options?.signal]);

      const runPromise = runner.run({
        goal,
        startUrl: testCase.startUrl,
        maxTurns: testCase.maxTurns ?? DEFAULT_MAX_TURNS,
        signal: combinedSignal,
      });

      let agentResult: AgentResult;
      if (timeoutMs && timeoutMs > 0 && timeoutAbortController) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<AgentResult>((resolve) => {
          timer = setTimeout(() => {
            timeoutAbortController.abort(`Test timed out after ${timeoutMs}ms`);
            resolve({
              success: false,
              reason: `Test timed out after ${timeoutMs}ms`,
              turns: [],
              totalMs: timeoutMs,
            });
          }, timeoutMs);
        });
        agentResult = await Promise.race([runPromise, timeoutPromise])
          .finally(() => { if (timer) clearTimeout(timer); });
      } else {
        agentResult = await runPromise;
      }

      // Ground-truth verification
      // Default to agent outcome when no explicit criteria are provided.
      let verified = agentResult.success;
      let criteriaResults: CriterionResult[] | undefined;

      if (testCase.successCriteria?.length && page) {
        criteriaResults = await this.verifyCriteria(testCase.successCriteria, page);
        verified = agentResult.success && criteriaResults.every((c) => c.passed);
      }

      // Save trajectory if memory enabled
      const tokensUsed = agentResult.turns.reduce((sum, t) => sum + (t.tokensUsed || 0), 0);
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

      const result: TestResult = {
        testCase,
        agentResult,
        agentSuccess: agentResult.success,
        verified,
        criteriaResults,
        verdict,
        turnsUsed: agentResult.turns.length,
        tokensUsed,
        durationMs: endedAt.getTime() - startedAt.getTime(),
        startedAt,
        endedAt,
        screenshots: screenshots.length > 0 ? screenshots : undefined,
      };

      // Emit video artifact if available
      if (this.artifactSink && page) {
        try {
          const videoPath = await page.video?.()?.path?.();
          if (videoPath) {
            const fs = await import('node:fs');
            if (fs.existsSync(videoPath)) {
              const videoData = fs.readFileSync(videoPath);
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
          }
        } catch {
          // Video capture is best-effort
        }
      }

      this.onTestComplete?.(result);
      this.onProgress?.({
        type: 'test:complete',
        testId: testCase.id,
        passed: result.verified,
        verdict: result.verdict,
        durationMs: result.durationMs,
        turnsUsed: result.turnsUsed,
        tokensUsed: result.tokensUsed,
      });
      return result;
    } finally {
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
  async runSuite(cases: TestCase[]): Promise<TestSuiteResult> {
    this.onProgress?.({ type: 'suite:start', totalTests: cases.length, concurrency: this.concurrency });

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

    this.onProgress?.({
      type: 'suite:complete',
      passed: result.summary.passed,
      failed: result.summary.failed,
      skipped: result.summary.skipped,
      totalMs: result.summary.totalDurationMs,
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
    if (testCase.timeoutMs !== undefined) return testCase.timeoutMs;
    return this.defaultTimeoutMs;
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
      startedAt: now,
      endedAt: now,
      skipped: true,
      skipReason: reason,
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
    const passed = nonSkipped.filter((r) => r.verified).length;

    return {
      model: this.config.model || 'unknown',
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
