#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import { assertApiKeyForModel, loadLocalEnvFiles } from './lib/env-loader.mjs';
import { resolveBenchmarkProfile } from './lib/benchmark-profiles.mjs';
import { classifyFailureReason, isExternalBlockerFailureClass } from './lib/failure-taxonomy.mjs';
import { loadExperimentSpec } from './lib/experiment-spec.mjs';
import { summarizeArtifactChecks } from './lib/artifact-completeness.mjs';
import { benchmarkSyncChildEnv, syncBenchmarkOutput } from './lib/abd-benchmark-sync.mjs';

const argv = process.argv.slice(2);
const getArg = (name, fallback = undefined) => {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  if (idx === argv.length - 1) return 'true';
  return argv[idx + 1];
};
const hasFlag = (name) => argv.includes(`--${name}`);

const rootDir = path.resolve(path.join(new URL('.', import.meta.url).pathname, '..'));
const specPath = getArg('spec');
const loadedSpec = specPath ? loadExperimentSpec(specPath) : undefined;
const spec = loadedSpec?.resolved;

const casesPath = path.resolve(
  spec?.casesPath
  ?? getArg('cases', './bench/scenarios/cases/staging-auth-ai-tangle.json'),
);
const storageState = spec?.storageState ?? getArg('storage-state');
const model = spec?.model ?? getArg('model', 'gpt-5.2');
const repetitions = Math.max(1, spec?.repetitions ?? Number.parseInt(getArg('repetitions', '10'), 10));
const concurrency = clampInt(spec?.concurrency ?? getArg('concurrency', '1'), 1, 32);
const scenarioConcurrency = clampInt(spec?.scenarioConcurrency ?? getArg('scenario-concurrency', '1'), 1, 32);
const outRoot = path.resolve(getArg('out', `./agent-results/ab-exp-${Date.now()}`));
const benchmarkProfileId = spec?.benchmarkProfile ?? getArg('benchmark-profile', 'default');
const benchmarkProfile = resolveBenchmarkProfile(benchmarkProfileId);
const seed = String(spec?.seed ?? getArg('seed', '1337'));
const globalModes = getArg(
  'modes',
  benchmarkProfile.id === 'webbench' ? 'fast-explore' : 'full-evidence,fast-explore',
);
const fixtureBaseUrl = spec?.fixtureBaseUrl ?? getArg('fixture-base-url');
const globalPromptFile = getArg('prompt-file');
const globalModelAdaptive = hasFlag('model-adaptive');
const globalNavModel = getArg('nav-model');
const globalNavProvider = getArg('nav-provider');
const memoryEnabled = hasFlag('memory');
const memoryDir = getArg('memory-dir');
const memoryRootArg = getArg('memory-root');
const memoryRoot = spec?.memoryRoot ?? (memoryRootArg ? path.resolve(memoryRootArg) : undefined);
const defaultMemoryIsolation = benchmarkProfile.id === 'webbench' ? 'per-run' : 'shared';
const memoryIsolation = spec?.memoryIsolation ?? getArg('memory-isolation', defaultMemoryIsolation);
const traceScoring = hasFlag('trace-scoring');
const traceTtlDays = getArg('trace-ttl-days');
const allowedMemoryIsolation = new Set(['none', 'shared', 'per-run']);

if (!allowedMemoryIsolation.has(String(memoryIsolation))) {
  throw new Error(`Invalid --memory-isolation value "${memoryIsolation}". Expected one of: none, shared, per-run`);
}

loadLocalEnvFiles(rootDir);
assertApiKeyForModel(model);

const defaultOffConfig = path.resolve(getArg('off-config', getArg('config-off', './bench/scenarios/configs/supervisor-off.mjs')));
const defaultOnConfig = path.resolve(getArg('on-config', getArg('config-on', './bench/scenarios/configs/supervisor-on.mjs')));
const defaultArms = [
  { id: 'off', configPath: defaultOffConfig, promptFile: undefined, modelAdaptive: undefined, navModel: undefined, navProvider: undefined },
  { id: 'on', configPath: defaultOnConfig, promptFile: undefined, modelAdaptive: undefined, navModel: undefined, navProvider: undefined },
];
const arms = spec?.arms?.length ? spec.arms : defaultArms;

if (!fs.existsSync(casesPath)) {
  console.error(`Cases file not found: ${casesPath}`);
  process.exit(1);
}
const casesRaw = JSON.parse(fs.readFileSync(casesPath, 'utf-8'));
if (!Array.isArray(casesRaw) || casesRaw.length === 0) {
  console.error(`Cases file must be a non-empty JSON array: ${casesPath}`);
  process.exit(1);
}

for (const arm of arms) {
  if (!fs.existsSync(arm.configPath)) {
    console.error(`Config path missing for arm "${arm.id}": ${arm.configPath}`);
    process.exit(1);
  }
}

const globalPromptMeta = resolvePromptMetadata(globalPromptFile ? path.resolve(globalPromptFile) : undefined);
const armPromptMeta = Object.fromEntries(
  arms.map((arm) => {
    const promptMeta = resolvePromptMetadata(arm.promptFile ?? globalPromptMeta.path ?? undefined);
    return [arm.id, promptMeta];
  }),
);

fs.mkdirSync(outRoot, { recursive: true });
const caseOrderDir = path.join(outRoot, '_case-orders');
fs.mkdirSync(caseOrderDir, { recursive: true });
const casesPathByRep = new Map();
const caseOrder = [];
for (let rep = 1; rep <= repetitions; rep++) {
  const orderedCases = buildRepCaseOrder(casesRaw, { seed, repetition: rep });
  const orderedPath = path.join(caseOrderDir, `rep-${String(rep).padStart(3, '0')}.json`);
  const orderedJson = `${JSON.stringify(orderedCases, null, 2)}\n`;
  fs.writeFileSync(orderedPath, orderedJson);
  casesPathByRep.set(rep, orderedPath);
  caseOrder.push({
    repetition: rep,
    casesPath: orderedPath,
    casesHash: sha256(orderedJson),
    caseIds: orderedCases.map((value, index) => String(value?.id ?? `case-${index + 1}`)),
  });
}

const jobs = [];
for (let rep = 1; rep <= repetitions; rep++) {
  for (const arm of arms) {
    jobs.push({ arm, rep });
  }
}

const runs = await runPool(jobs, concurrency, async ({ arm, rep }) => {
  const runDir = path.join(outRoot, `${arm.id}-run-${String(rep).padStart(3, '0')}`);
  fs.mkdirSync(runDir, { recursive: true });

  const args = [
    'scripts/run-scenario-track.mjs',
    '--cases', casesPathByRep.get(rep),
    '--config', arm.configPath,
    '--model', model,
    '--out', runDir,
    '--concurrency', String(scenarioConcurrency),
    '--benchmark-profile', benchmarkProfile.id,
    '--modes', globalModes,
    '--memory-isolation', memoryIsolation,
  ];
  if (storageState) args.push('--storage-state', storageState);
  if (fixtureBaseUrl) args.push('--fixture-base-url', fixtureBaseUrl);
  const promptMeta = armPromptMeta[arm.id];
  if (promptMeta.path) args.push('--prompt-file', promptMeta.path);
  if ((arm.modelAdaptive ?? globalModelAdaptive) === true) args.push('--model-adaptive');
  if (arm.navModel ?? globalNavModel) args.push('--nav-model', arm.navModel ?? globalNavModel);
  if (arm.navProvider ?? globalNavProvider) args.push('--nav-provider', arm.navProvider ?? globalNavProvider);
  if (memoryEnabled) args.push('--memory');
  if (memoryDir) args.push('--memory-dir', memoryDir);
  if (memoryRoot) args.push('--memory-root', memoryRoot);
  if (memoryIsolation === 'per-run') args.push('--memory-scope-id', `${arm.id}-run-${String(rep).padStart(3, '0')}`);
  if (traceScoring) args.push('--trace-scoring');
  if (traceTtlDays) args.push('--trace-ttl-days', traceTtlDays);

  const startedAt = Date.now();
  const exitCode = await spawnAndWait('node', args, {
    cwd: rootDir,
    env: benchmarkSyncChildEnv(process.env),
    stdio: 'inherit',
  });
  const endedAt = Date.now();
  const metrics = collectMetrics(runDir);
  const trackSummary = loadTrackSummary(runDir);
  return {
    arm: arm.id,
    repetition: rep,
    runDir,
    exitCode,
    elapsedMs: endedAt - startedAt,
    promptFile: promptMeta.path,
    promptHash: promptMeta.hash,
    artifactChecks: trackSummary?.artifactChecks ?? summarizeArtifactChecks([]),
    ...metrics,
  };
});

const byArm = summarizeByArm(runs);
const armIds = Object.keys(byArm);
const summary = {
  generatedAt: new Date().toISOString(),
  gitSha: safeGitSha(rootDir),
  specPath: loadedSpec?.specPath ?? null,
  casesPath,
  seed,
  caseOrder,
  storageState: storageState ?? null,
  model,
  benchmarkProfile: benchmarkProfile.id,
  driverProfile: benchmarkProfile.driverProfile,
  modes: globalModes.split(',').map((value) => value.trim()).filter(Boolean),
  repetitions,
  outRoot,
  memory: {
    enabled: memoryEnabled,
    isolation: memoryIsolation,
    memoryDir: memoryDir ?? null,
    memoryRoot: memoryRoot ?? null,
  },
  prompt: {
    global: globalPromptMeta,
    byArm: armPromptMeta,
  },
  arms: arms.map((arm) => ({
    id: arm.id,
    configPath: arm.configPath,
    promptFile: armPromptMeta[arm.id]?.path ?? null,
    promptHash: armPromptMeta[arm.id]?.hash ?? null,
    modelAdaptive: arm.modelAdaptive ?? globalModelAdaptive,
    navModel: arm.navModel ?? globalNavModel ?? null,
    navProvider: arm.navProvider ?? globalNavProvider ?? null,
  })),
  runs,
  byArm,
  artifactChecks: summarizeArtifactChecks(runs.flatMap((run) => run.artifactChecks?.rows ?? [])),
  delta: buildDelta(armIds, byArm, runs),
};

const summaryPath = path.join(outRoot, 'summary.json');
fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
writeCsv(path.join(outRoot, 'runs.csv'), runs);
writePassRateSeries(path.join(outRoot, 'passrate-series.csv'), runs);
writeMarkdown(path.join(outRoot, 'summary.md'), summary);

console.log('\nAB experiment complete');
console.log(`- summary: ${summaryPath}`);
for (const armId of armIds) {
  const arm = byArm[armId];
  console.log(
    `- ${armId}: raw ${(arm.rawPassRate.mean * 100).toFixed(2)}% | clean ${(arm.cleanPassRate.mean * 100).toFixed(2)}% | blocked ${arm.blockedTests}`,
  );
}
if (summary.delta) {
  console.log(
    `- delta (${summary.delta.treatment} - ${summary.delta.control}): raw ${(summary.delta.raw.onMinusOff * 100).toFixed(2)}pp | clean ${(summary.delta.clean.onMinusOff * 100).toFixed(2)}pp`,
  );
}
console.log(`- artifacts: ${summary.artifactChecks.passed}/${summary.artifactChecks.total} track checks passed`);

await syncBenchmarkOutput({
  rootDir,
  outPath: outRoot,
  label: `${path.basename(casesPath)} · ab experiment`,
});

const runFailures = runs
  .filter((run) => run.exitCode !== 0)
  .map((run) => `${run.arm} run ${run.repetition} exited with code ${run.exitCode}`);
const artifactFailures = runs
  .flatMap((run) => (run.artifactChecks?.rows ?? [])
    .filter((row) => !row?.passed)
    .map((row) => `${run.arm} run ${run.repetition}: ${row.scenarioId} (${row.mode}) artifact check failed: ${row.failures.join('; ')}`));
if (runFailures.length > 0 || artifactFailures.length > 0) {
  for (const failure of [...runFailures, ...artifactFailures]) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

function clampInt(value, min, max) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return min;
  return Math.max(min, Math.min(max, parsed));
}

function spawnAndWait(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    child.once('error', () => resolve(1));
    child.once('close', (code) => resolve(code ?? 1));
  });
}

async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runner() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  const workerCount = Math.min(limit, Math.max(1, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => runner()));
  return results;
}

function collectMetrics(runDir) {
  const reports = findSuiteReports(runDir);
  let totalTests = 0;
  let passedTests = 0;
  let evaluableTests = 0;
  let cleanPassedTests = 0;
  let blockedTests = 0;
  let totalTurns = 0;
  let totalDurationMs = 0;
  let totalTokens = 0;
  const testOutcomes = [];
  const cleanOutcomes = [];
  const failureClassCounts = {};

  for (const reportPath of reports) {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    for (const result of report.results ?? []) {
      totalTests++;
      const passed = result.verified === true;
      const reason = String(result.agentResult?.reason || result.verdict || '').trim();
      const failureClass = passed ? null : classifyFailureReason(reason);
      const blocked = !passed && isExternalBlockerFailureClass(failureClass);

      if (passed) passedTests++;
      totalTurns += Number(result.turnsUsed ?? 0);
      totalDurationMs += Number(result.durationMs ?? 0);
      totalTokens += Number(result.tokensUsed ?? 0);
      testOutcomes.push(passed ? 1 : 0);

      if (blocked) {
        blockedTests++;
      } else {
        evaluableTests++;
        cleanOutcomes.push(passed ? 1 : 0);
        if (passed) cleanPassedTests++;
      }

      if (!passed && failureClass) {
        failureClassCounts[failureClass] = (failureClassCounts[failureClass] ?? 0) + 1;
      }
    }
  }

  const passRate = totalTests > 0 ? passedTests / totalTests : 0;
  const cleanPassRate = evaluableTests > 0 ? cleanPassedTests / evaluableTests : 0;
  return {
    totalTests,
    passedTests,
    passRate,
    evaluableTests,
    cleanPassedTests,
    cleanPassRate,
    blockedTests,
    avgTurns: totalTests > 0 ? totalTurns / totalTests : 0,
    avgDurationMs: totalTests > 0 ? totalDurationMs / totalTests : 0,
    avgTokens: totalTests > 0 ? totalTokens / totalTests : 0,
    testOutcomes,
    cleanOutcomes,
    failureClassCounts,
  };
}

function summarizeByArm(runs) {
  const armSummary = {};
  const armIds = [...new Set(runs.map((run) => run.arm))];

  for (const armId of armIds) {
    const armRuns = runs.filter((run) => run.arm === armId);
    const rawPassRates = armRuns.map((run) => run.passRate);
    const cleanPassRates = armRuns.map((run) => run.cleanPassRate);
    const totals = armRuns.reduce((acc, run) => acc + run.totalTests, 0);
    const passed = armRuns.reduce((acc, run) => acc + run.passedTests, 0);
    const evaluableTests = armRuns.reduce((acc, run) => acc + run.evaluableTests, 0);
    const cleanPassedTests = armRuns.reduce((acc, run) => acc + run.cleanPassedTests, 0);
    const blockedTests = armRuns.reduce((acc, run) => acc + run.blockedTests, 0);
    const artifactRows = armRuns.flatMap((run) => run.artifactChecks?.rows ?? []);

    armSummary[armId] = {
      runs: armRuns.length,
      totalTests: totals,
      passedTests: passed,
      evaluableTests,
      cleanPassedTests,
      blockedTests,
      artifactChecks: summarizeArtifactChecks(artifactRows),
      rawPassRate: {
        mean: mean(rawPassRates),
        stddev: stddev(rawPassRates),
        wilson95: wilsonInterval(passed, totals),
      },
      cleanPassRate: {
        mean: mean(cleanPassRates),
        stddev: stddev(cleanPassRates),
        wilson95: wilsonInterval(cleanPassedTests, evaluableTests),
      },
      avgTurns: mean(armRuns.map((run) => run.avgTurns)),
      avgDurationMs: mean(armRuns.map((run) => run.avgDurationMs)),
      avgTokens: mean(armRuns.map((run) => run.avgTokens)),
      failureClassCounts: mergeCounts(armRuns.map((run) => run.failureClassCounts)),
    };
  }
  return armSummary;
}

function buildDelta(armIds, byArm, runs) {
  if (!byArm.off || !byArm.on) return null;
  const onOutcomes = runs.filter((run) => run.arm === 'on').flatMap((run) => run.testOutcomes);
  const offOutcomes = runs.filter((run) => run.arm === 'off').flatMap((run) => run.testOutcomes);
  const onCleanOutcomes = runs.filter((run) => run.arm === 'on').flatMap((run) => run.cleanOutcomes);
  const offCleanOutcomes = runs.filter((run) => run.arm === 'off').flatMap((run) => run.cleanOutcomes);
  return {
    control: 'off',
    treatment: 'on',
    raw: {
      onMinusOff: byArm.on.rawPassRate.mean - byArm.off.rawPassRate.mean,
      bootstrap95: bootstrapDiff95(onOutcomes, offOutcomes, 2000, 11),
    },
    clean: {
      onMinusOff: byArm.on.cleanPassRate.mean - byArm.off.cleanPassRate.mean,
      bootstrap95: bootstrapDiff95(onCleanOutcomes, offCleanOutcomes, 2000, 17),
    },
  };
}

function findSuiteReports(root) {
  const reports = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === 'report.json' && full.includes(`${path.sep}suite${path.sep}`)) {
        reports.push(full);
      }
    }
  };
  walk(root);
  return reports;
}

function loadTrackSummary(runDir) {
  const summaryPath = path.join(runDir, 'track-summary.json');
  if (!fs.existsSync(summaryPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));
  } catch {
    return null;
  }
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function stddev(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance = values.reduce((acc, value) => acc + ((value - avg) ** 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function wilsonInterval(successes, n, z = 1.96) {
  if (n === 0) return [0, 0];
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

function bootstrapDiff95(onOutcomes, offOutcomes, samples = 2000, seed = 7) {
  if (onOutcomes.length === 0 || offOutcomes.length === 0) return [0, 0];
  let state = seed >>> 0;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };

  const diffs = [];
  for (let i = 0; i < samples; i++) {
    const onSampleMean = resampleMean(onOutcomes, random);
    const offSampleMean = resampleMean(offOutcomes, random);
    diffs.push(onSampleMean - offSampleMean);
  }
  diffs.sort((a, b) => a - b);
  const lo = diffs[Math.floor(samples * 0.025)];
  const hi = diffs[Math.floor(samples * 0.975)];
  return [lo, hi];
}

function resampleMean(values, random) {
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    const idx = Math.floor(random() * values.length);
    total += values[idx];
  }
  return total / values.length;
}

function writeCsv(filePath, rows) {
  const header = [
    'arm',
    'repetition',
    'exitCode',
    'elapsedMs',
    'totalTests',
    'passedTests',
    'rawPassRate',
    'evaluableTests',
    'cleanPassedTests',
    'cleanPassRate',
    'blockedTests',
    'avgTurns',
    'avgDurationMs',
    'avgTokens',
    'promptHash',
    'runDir',
  ];
  const lines = [header.join(',')];
  for (const row of rows) {
    const values = [
      row.arm,
      row.repetition,
      row.exitCode,
      row.elapsedMs,
      row.totalTests,
      row.passedTests,
      row.passRate,
      row.evaluableTests,
      row.cleanPassedTests,
      row.cleanPassRate,
      row.blockedTests,
      row.avgTurns,
      row.avgDurationMs,
      row.avgTokens,
      row.promptHash ?? '',
      csvEscape(row.runDir),
    ];
    lines.push(values.join(','));
  }
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

function writePassRateSeries(filePath, runs) {
  const lines = ['arm,repetition,rawPassRate,cleanPassRate,blockedTests'];
  for (const run of runs) {
    lines.push([run.arm, run.repetition, run.passRate, run.cleanPassRate, run.blockedTests].join(','));
  }
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

function csvEscape(value) {
  const stringValue = String(value ?? '');
  if (!/[",\n]/.test(stringValue)) return stringValue;
  return `"${stringValue.replace(/"/g, '""')}"`;
}

function writeMarkdown(filePath, summary) {
  const lines = [];
  lines.push('# AB Experiment Summary');
  lines.push('');
  lines.push(`- Generated: ${summary.generatedAt}`);
  lines.push(`- Cases: \`${summary.casesPath}\``);
  lines.push(`- Model: \`${summary.model}\``);
  lines.push(`- Benchmark profile: \`${summary.benchmarkProfile}\` -> \`${summary.driverProfile}\``);
  lines.push(`- Repetitions per arm: ${summary.repetitions}`);
  lines.push(`- Seed: \`${summary.seed}\``);
  if (summary.specPath) lines.push(`- Spec: \`${summary.specPath}\``);
  lines.push('');
  lines.push('## Arm Metrics');
  lines.push('');
  lines.push('| Arm | Raw Pass | Raw 95% CI | Clean Pass | Clean 95% CI | Blocked |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const [armId, arm] of Object.entries(summary.byArm)) {
    lines.push(
      `| ${armId} | ${(arm.rawPassRate.mean * 100).toFixed(2)}% | ${(arm.rawPassRate.wilson95[0] * 100).toFixed(2)}% - ${(arm.rawPassRate.wilson95[1] * 100).toFixed(2)}% | ${(arm.cleanPassRate.mean * 100).toFixed(2)}% | ${(arm.cleanPassRate.wilson95[0] * 100).toFixed(2)}% - ${(arm.cleanPassRate.wilson95[1] * 100).toFixed(2)}% | ${arm.blockedTests} |`,
    );
  }
  lines.push('');
  lines.push('## Artifact Completeness');
  lines.push('');
  lines.push(`- Total checks: ${summary.artifactChecks.total}`);
  lines.push(`- Passed: ${summary.artifactChecks.passed}`);
  lines.push(`- Failed: ${summary.artifactChecks.failed}`);
  if (summary.delta) {
    lines.push('');
    lines.push('## Delta');
    lines.push('');
    lines.push(`- Raw ${summary.delta.treatment} - ${summary.delta.control}: ${(summary.delta.raw.onMinusOff * 100).toFixed(2)}pp`);
    lines.push(`- Raw bootstrap 95% CI: ${(summary.delta.raw.bootstrap95[0] * 100).toFixed(2)}pp to ${(summary.delta.raw.bootstrap95[1] * 100).toFixed(2)}pp`);
    lines.push(`- Clean ${summary.delta.treatment} - ${summary.delta.control}: ${(summary.delta.clean.onMinusOff * 100).toFixed(2)}pp`);
    lines.push(`- Clean bootstrap 95% CI: ${(summary.delta.clean.bootstrap95[0] * 100).toFixed(2)}pp to ${(summary.delta.clean.bootstrap95[1] * 100).toFixed(2)}pp`);
  }
  lines.push('');
  lines.push('## Files');
  lines.push('');
  lines.push('- `summary.json`');
  lines.push('- `runs.csv`');
  lines.push('- `passrate-series.csv`');
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

function buildRepCaseOrder(cases, options) {
  const scored = cases.map((scenario, index) => ({
    scenario,
    index,
    key: sha256(`${options.seed}:${options.repetition}:${index}:${String(scenario?.id ?? '')}`),
  }));
  scored.sort((a, b) => {
    if (a.key < b.key) return -1;
    if (a.key > b.key) return 1;
    return a.index - b.index;
  });
  return scored.map((entry) => entry.scenario);
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function resolvePromptMetadata(promptFilePath) {
  if (!promptFilePath) {
    return { path: null, hash: null };
  }
  const absolute = path.resolve(promptFilePath);
  if (!fs.existsSync(absolute)) {
    throw new Error(`Prompt file not found: ${absolute}`);
  }
  const text = fs.readFileSync(absolute, 'utf-8');
  return { path: absolute, hash: crypto.createHash('sha256').update(text).digest('hex') };
}

function mergeCounts(countObjects) {
  const merged = {};
  for (const counts of countObjects) {
    for (const [key, value] of Object.entries(counts || {})) {
      merged[key] = (merged[key] ?? 0) + Number(value ?? 0);
    }
  }
  return merged;
}

function safeGitSha(cwd) {
  try {
    return execSync('git rev-parse HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}
