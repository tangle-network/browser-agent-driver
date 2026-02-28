/**
 * Coordinator — orchestrates test suite execution across multiple sandboxes.
 *
 * Flow: split cases → provision sandboxes → distribute work → stream progress
 * → collect artifacts → aggregate results → cleanup.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  CoordinatorConfig,
  CoordinatorEvent,
  AggregatedResult,
  ArtifactSummary,
  ManifestEntry,
  Sandbox,
  AgentConfig,
  TestCase,
  TestSuiteResult,
  ProgressEvent,
} from './types.js';

export class Coordinator {
  private readonly provider;
  private readonly concurrency: number;
  private readonly cases: TestCase[];
  private readonly agentConfig: AgentConfig;
  private readonly onProgress?: (event: CoordinatorEvent) => void;
  private readonly outputDir: string;

  constructor(config: CoordinatorConfig) {
    this.provider = config.provider;
    this.concurrency = config.concurrency;
    this.cases = config.cases;
    this.agentConfig = config.agentConfig;
    this.onProgress = config.onProgress;
    this.outputDir = config.outputDir ?? './sandbox-results';
  }

  /** Run all test cases across sandboxes, return aggregated results */
  async run(): Promise<AggregatedResult> {
    const startTime = Date.now();

    // Ensure output directory exists
    mkdirSync(this.outputDir, { recursive: true });

    // 1. Split cases into chunks (round-robin by priority)
    const sorted = [...this.cases].sort(
      (a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity)
    );
    const sandboxCount = Math.min(this.concurrency, sorted.length);
    const chunks = splitRoundRobin(sorted, sandboxCount);

    this.emit({ type: 'coordinator:start', totalTests: this.cases.length, sandboxes: sandboxCount });

    // 2. Provision sandboxes in parallel
    const sandboxes = await this.provisionSandboxes(sandboxCount, chunks);

    // 3. Distribute work + stream progress from each sandbox
    const suiteResults = await this.distributeTasks(sandboxes, chunks);

    // 4. Aggregate results
    const result = this.aggregate(suiteResults, Date.now() - startTime, sandboxCount);

    // Write aggregated result to output dir
    writeFileSync(
      join(this.outputDir, 'aggregated-result.json'),
      JSON.stringify(result, null, 2)
    );

    this.emit({ type: 'coordinator:complete', result });

    // 5. Cleanup
    await this.provider.destroyAll();

    return result;
  }

  private async provisionSandboxes(
    count: number,
    chunks: TestCase[][],
  ): Promise<Sandbox[]> {
    const sandboxes: Sandbox[] = [];

    const provisions = Array.from({ length: count }, async (_, i) => {
      const env: Record<string, string> = {};

      // Pass LLM config as env vars
      if (this.agentConfig.apiKey) {
        const envKey = this.agentConfig.provider === 'anthropic'
          ? 'ANTHROPIC_API_KEY'
          : this.agentConfig.provider === 'google'
            ? 'GOOGLE_API_KEY'
            : 'OPENAI_API_KEY';
        env[envKey] = this.agentConfig.apiKey;
      }
      if (this.agentConfig.baseUrl) {
        env['LLM_BASE_URL'] = this.agentConfig.baseUrl;
      }

      try {
        const sandbox = await this.provider.provision({
          id: `sandbox-${i}`,
          env,
        });

        sandboxes.push(sandbox);
        this.emit({
          type: 'sandbox:provisioned',
          sandboxId: sandbox.id,
          testsAssigned: chunks[i]?.length ?? 0,
        });
        return sandbox;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.emit({ type: 'sandbox:failed', sandboxId: `sandbox-${i}`, error: message });
        throw err;
      }
    });

    await Promise.all(provisions);
    return sandboxes;
  }

  private async distributeTasks(
    sandboxes: Sandbox[],
    chunks: TestCase[][],
  ): Promise<TestSuiteResult[]> {
    const results = await Promise.allSettled(
      sandboxes.map((sandbox, i) =>
        this.runInSandbox(sandbox, chunks[i] ?? [])
      )
    );

    return results
      .filter((r): r is PromiseFulfilledResult<TestSuiteResult> => r.status === 'fulfilled')
      .map((r) => r.value);
  }

  private async runInSandbox(
    sandbox: Sandbox,
    cases: TestCase[],
  ): Promise<TestSuiteResult> {
    this.emit({ type: 'sandbox:started', sandboxId: sandbox.id });

    // Write test cases to sandbox (strip non-serializable fields like functions)
    const casesFile = '/tmp/cases.json';
    const outputDir = '/output/';
    const serializableCases = cases.map(serializeTestCase);
    await sandbox.writeFile(casesFile, JSON.stringify(serializableCases, null, 2));

    // Build the agent-driver run command
    const cmd = buildRunCommand(this.agentConfig, casesFile, outputDir);

    // Stream execution and parse JSON-lines progress events
    let suiteResult: TestSuiteResult | undefined;
    let passed = 0;
    let failed = 0;

    try {
      for await (const line of sandbox.execStream(cmd)) {
        // Debug: log raw lines from sandbox
        if (process.env.DEBUG_COORDINATOR) {
          process.stderr.write(`  [${sandbox.id}:raw] ${line}\n`);
        }
        const event = tryParseProgressEvent(line);
        if (!event) continue;

        // Re-emit sandbox progress
        this.emit({ type: 'sandbox:progress', sandboxId: sandbox.id, event });

        // Track pass/fail counts
        if (event.type === 'test:complete') {
          if (event.passed) passed++;
          else failed++;
        }
      }

      // Collect the result JSON from the sandbox
      try {
        const resultBuffer = await sandbox.readFile('/output/report.json');
        suiteResult = JSON.parse(resultBuffer.toString('utf-8')) as TestSuiteResult;
      } catch {
        // If report.json not available, build a minimal result
      }

      // Collect artifacts to local output dir
      await this.collectArtifacts(sandbox);

      this.emit({ type: 'sandbox:completed', sandboxId: sandbox.id, passed, failed });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ type: 'sandbox:failed', sandboxId: sandbox.id, error: message });
    }

    return suiteResult ?? buildEmptyResult(this.agentConfig.model, passed, failed, cases.length);
  }

  private async collectArtifacts(sandbox: Sandbox): Promise<void> {
    const localDir = join(this.outputDir, sandbox.id);
    mkdirSync(localDir, { recursive: true });

    // Strategy 1: Bulk copy via docker cp (efficient, binary-safe)
    if (sandbox.copyDirectory) {
      try {
        await sandbox.copyDirectory('/output', localDir);
        const summary = await this.buildArtifactSummary(sandbox, localDir);
        this.emit({ type: 'sandbox:artifacts', sandboxId: sandbox.id, artifacts: summary });
        return;
      } catch {
        // Fall through to manifest-driven extraction
      }
    }

    // Strategy 2: Manifest-driven extraction (works with any provider)
    let collected = 0;
    let totalBytes = 0;
    const byType: Record<string, number> = {};

    try {
      const manifestBuffer = await sandbox.readFile('/output/suite/manifest.json');
      writeFileSync(join(localDir, 'manifest.json'), manifestBuffer);

      const manifest = JSON.parse(manifestBuffer.toString('utf-8')) as ManifestEntry[];

      for (const entry of manifest) {
        const remotePath = entry.uri.replace('file://', '');
        const localFilePath = join(localDir, entry.testId, entry.name);
        mkdirSync(dirname(localFilePath), { recursive: true });

        try {
          const data = await sandbox.readFile(remotePath);
          writeFileSync(localFilePath, data);
          collected++;
          totalBytes += data.length;
          byType[entry.type] = (byType[entry.type] ?? 0) + 1;
        } catch {
          // Skip files we can't read
        }
      }

      // Also grab suite-level reports
      for (const name of ['report.json', 'report.md']) {
        try {
          const data = await sandbox.readFile(`/output/suite/${name}`);
          const suitePath = join(localDir, 'suite', name);
          mkdirSync(dirname(suitePath), { recursive: true });
          writeFileSync(suitePath, data);
          collected++;
          totalBytes += data.length;
          byType['report'] = (byType['report'] ?? 0) + 1;
        } catch {
          // Optional files
        }
      }
    } catch {
      // Manifest not available — try flat listing as last resort
      try {
        await this.collectArtifactsFlat(sandbox, localDir, '/output');
      } catch {
        // /output may not exist if the run failed early
      }
    }

    this.emit({
      type: 'sandbox:artifacts',
      sandboxId: sandbox.id,
      artifacts: { fileCount: collected, totalBytes, byType, localDir },
    });
  }

  /** Build artifact summary from manifest after bulk copy */
  private async buildArtifactSummary(sandbox: Sandbox, localDir: string): Promise<ArtifactSummary> {
    try {
      const manifestBuffer = await sandbox.readFile('/output/suite/manifest.json');
      const manifest = JSON.parse(manifestBuffer.toString('utf-8')) as ManifestEntry[];
      const byType: Record<string, number> = {};
      let totalBytes = 0;

      for (const entry of manifest) {
        byType[entry.type] = (byType[entry.type] ?? 0) + 1;
        totalBytes += entry.sizeBytes;
      }

      return { fileCount: manifest.length, totalBytes, byType, localDir };
    } catch {
      return { fileCount: 0, totalBytes: 0, byType: {}, localDir };
    }
  }

  /** Recursively collect files from a directory tree */
  private async collectArtifactsFlat(
    sandbox: Sandbox,
    localDir: string,
    remotePath: string,
  ): Promise<void> {
    const entries = await sandbox.listFiles(remotePath);
    for (const entry of entries) {
      const localPath = join(localDir, entry.name);
      if (entry.isDirectory) {
        mkdirSync(localPath, { recursive: true });
        await this.collectArtifactsFlat(sandbox, localPath, entry.path);
      } else {
        try {
          const data = await sandbox.readFile(entry.path);
          writeFileSync(localPath, data);
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  private aggregate(
    suiteResults: TestSuiteResult[],
    totalDurationMs: number,
    sandboxesUsed: number,
  ): AggregatedResult {
    let total = 0;
    let passed = 0;
    let failed = 0;
    let skipped = 0;

    for (const suite of suiteResults) {
      total += suite.summary.total;
      passed += suite.summary.passed;
      failed += suite.summary.failed;
      skipped += suite.summary.skipped;
    }

    return {
      suiteResults,
      summary: {
        total,
        passed,
        failed,
        skipped,
        passRate: total > 0 ? passed / total : 0,
        totalDurationMs,
        sandboxesUsed,
      },
      timestamp: new Date().toISOString(),
    };
  }

  private emit(event: CoordinatorEvent): void {
    this.onProgress?.(event);
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Split array into N chunks using round-robin distribution */
function splitRoundRobin<T>(items: T[], n: number): T[][] {
  const chunks: T[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < items.length; i++) {
    chunks[i % n]!.push(items[i]!);
  }
  return chunks;
}

/** Strip non-serializable fields (setup/teardown functions, custom check functions) */
function serializeTestCase(tc: TestCase): Record<string, unknown> {
  return {
    id: tc.id,
    name: tc.name,
    description: tc.description,
    category: tc.category,
    tags: tc.tags,
    startUrl: tc.startUrl,
    goal: tc.goal,
    maxTurns: tc.maxTurns,
    timeoutMs: tc.timeoutMs,
    priority: tc.priority,
    dependsOn: tc.dependsOn,
    successDescription: tc.successDescription,
    // successCriteria with custom check functions are stripped
    successCriteria: tc.successCriteria
      ?.filter((c) => c.type !== 'custom')
      .map((c) => {
        const { check: _check, ...rest } = c;
        return rest;
      }),
  };
}

/** Build the agent-driver CLI command */
function buildRunCommand(config: AgentConfig, casesFile: string, outputDir: string): string {
  // If the caller provided a custom command template, use it
  if (config.runCommand) {
    return config.runCommand
      .replace(/\{casesFile\}/g, casesFile)
      .replace(/\{outputDir\}/g, outputDir) + ' 2>&1';
  }

  const parts = [
    'node', '/app/dist/cli.js', 'run',
    '--cases', casesFile,
    '--json',
    '--sink', outputDir,
    '--model', config.model,
    '--provider', config.provider,
  ];

  if (config.maxTurns) {
    parts.push('--max-turns', String(config.maxTurns));
  }
  if (config.vision === false) {
    parts.push('--no-vision');
  }
  if (config.goalVerification === false) {
    parts.push('--no-goal-verification');
  }
  if (config.headless !== false) {
    parts.push('--headless');
  }

  // Redirect stderr to stdout so we can capture errors in execStream
  return parts.join(' ') + ' 2>&1';
}

/** Try to parse a JSON line as a ProgressEvent */
function tryParseProgressEvent(line: string): ProgressEvent | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (typeof parsed.type === 'string' && parsed.type.includes(':')) {
      return parsed as unknown as ProgressEvent;
    }
    return null;
  } catch {
    return null;
  }
}

/** Build a minimal TestSuiteResult when report.json isn't available */
function buildEmptyResult(
  model: string,
  passed: number,
  failed: number,
  total: number,
): TestSuiteResult {
  return {
    model,
    timestamp: new Date().toISOString(),
    results: [],
    summary: {
      total,
      passed,
      failed,
      skipped: total - passed - failed,
      passRate: total > 0 ? passed / total : 0,
      avgTurns: 0,
      avgTokens: 0,
      avgDurationMs: 0,
      p50DurationMs: 0,
      p95DurationMs: 0,
      totalDurationMs: 0,
    },
  };
}
