#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import { assertApiKeyForModel, loadLocalEnvFiles } from './lib/env-loader.mjs';
import { resolveBenchmarkProfile } from './lib/benchmark-profiles.mjs';
import { formatArtifactCheckFailures, summarizeArtifactChecks, verifyModeArtifacts } from './lib/artifact-completeness.mjs';
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

const explicitGoal = getArg('goal');
const explicitUrl = getArg('url');
const casesPathArg = getArg('cases');
const fixtureBaseUrl = getArg('fixture-base-url');
const providerOverride = getArg('provider');
const baseUrlOverride = getArg('base-url');
const apiKeyOverride = getArg('api-key');
const fallbackGoal = 'Navigate to /partner/coinbase and verify Coinbase templates are visible.';
const fallbackUrl = 'https://ai.tangle.tools';
let goal = explicitGoal ?? fallbackGoal;
let url = explicitUrl ?? fallbackUrl;
const model = getArg('model', 'gpt-5.2');
const configPath = getArg('config');
const persona = getArg('persona', 'auto');
const benchmarkProfileId = getArg('benchmark-profile', 'default');
const benchmarkProfile = resolveBenchmarkProfile(benchmarkProfileId);
const storageState = getArg('storage-state');
const hasExplicitMaxTurns = argv.includes('--max-turns');
const hasExplicitTimeout = argv.includes('--timeout-ms') || argv.includes('--timeout');
let maxTurns = Number.parseInt(getArg('max-turns', '50'), 10);
let timeoutMs = Number.parseInt(getArg('timeout-ms', getArg('timeout', '600000')), 10);
let allowedDomains = parseDomainCsv(getArg('allowed-domains'));
const runId = `${Date.now()}`;
const outBase = path.resolve(getArg('out', `./agent-results/mode-baseline-${runId}`));
const debug = hasFlag('debug');
const modelAdaptive = hasFlag('model-adaptive');
const navModel = getArg('nav-model');
const navProvider = getArg('nav-provider');
const memory = hasFlag('memory');
const memoryDir = getArg('memory-dir');
const memoryRoot = getArg('memory-root');
const memoryIsolation = getArg('memory-isolation', 'shared');
const memoryScopeId = getArg('memory-scope-id');
const promptFile = getArg('prompt-file');
const traceScoring = hasFlag('trace-scoring');
const traceTtlDays = getArg('trace-ttl-days');
const headless = hasFlag('headless');
const allowedMemoryIsolation = new Set(['none', 'shared', 'per-run']);
const allowedModes = new Set(['full-evidence', 'fast-explore']);
const modes = parseModes(getArg('modes', 'full-evidence,fast-explore'));
let resolvedCaseMeta = null;

if (casesPathArg) {
  const casesPath = path.resolve(casesPathArg);
  if (!fs.existsSync(casesPath)) {
    throw new Error(`Cases file not found: ${casesPath}`);
  }
  const cases = JSON.parse(fs.readFileSync(casesPath, 'utf-8'));
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error(`Cases file must be a non-empty JSON array: ${casesPath}`);
  }
  const firstCase = cases[0];
  if (!explicitGoal) goal = String(firstCase.goal ?? goal);
  if (!explicitUrl) url = String(firstCase.startUrl ?? url);
  // Substitute __FIXTURE_BASE_URL__ if the case uses the placeholder.
  // Mirrors run-scenario-track.mjs so single-scenario runs reach the static
  // fixture server the same way the gate does.
  if (typeof url === 'string' && url.includes('__FIXTURE_BASE_URL__')) {
    if (!fixtureBaseUrl) {
      throw new Error(
        `Case "${firstCase.id ?? 'unknown'}" contains __FIXTURE_BASE_URL__ but --fixture-base-url was not provided`,
      );
    }
    url = url.replace('__FIXTURE_BASE_URL__', fixtureBaseUrl);
  }
  if (allowedDomains === undefined && Array.isArray(firstCase.allowedDomains)) {
    allowedDomains = firstCase.allowedDomains.filter((domain) => typeof domain === 'string' && domain.length > 0);
  }
  if (!hasExplicitMaxTurns && Number.isFinite(Number(firstCase.maxTurns))) {
    maxTurns = Number(firstCase.maxTurns);
  }
  if (!hasExplicitTimeout && Number.isFinite(Number(firstCase.timeoutMs))) {
    timeoutMs = Number(firstCase.timeoutMs);
  }
  resolvedCaseMeta = {
    casesPath,
    selectedCaseId: firstCase.id ?? null,
    selectedCaseName: firstCase.name ?? null,
    totalCasesInFile: cases.length,
  };
}

// Same substitution for explicitly-passed --url so callers can mix
// fixture cases and direct URL flags consistently.
if (typeof url === 'string' && url.includes('__FIXTURE_BASE_URL__')) {
  if (!fixtureBaseUrl) {
    throw new Error('--url contains __FIXTURE_BASE_URL__ but --fixture-base-url was not provided');
  }
  url = url.replace('__FIXTURE_BASE_URL__', fixtureBaseUrl);
}

loadLocalEnvFiles(rootDir);
assertApiKeyForModel(model);
if (!allowedMemoryIsolation.has(String(memoryIsolation))) {
  throw new Error(`Invalid --memory-isolation value "${memoryIsolation}". Expected one of: none, shared, per-run`);
}

const resolvedPromptFile = promptFile ? path.resolve(promptFile) : undefined;
if (resolvedPromptFile && !fs.existsSync(resolvedPromptFile)) {
  throw new Error(`Prompt file not found: ${resolvedPromptFile}`);
}
const promptHash = resolvedPromptFile ? sha256(fs.readFileSync(resolvedPromptFile, 'utf-8')) : null;

fs.mkdirSync(outBase, { recursive: true });

function runMode(mode) {
  const modeDir = path.join(outBase, mode);
  const memoryConfig = resolveMemoryConfig({
    enabled: memory,
    isolation: memoryIsolation,
    memoryDir,
    memoryRoot,
    outBase,
    mode,
    memoryScopeId,
  });
  const args = [
    'dist/cli.js',
    'run',
    '--goal', goal,
    '--url', url,
    '--model', model,
    '--mode', mode,
    '--max-turns', String(maxTurns),
    '--timeout', String(timeoutMs),
    '--sink', modeDir,
    '--profile', benchmarkProfile.driverProfile,
  ];
  if (allowedDomains && allowedDomains.length > 0) args.push('--allowed-domains', allowedDomains.join(','));
  if (persona) args.push('--persona', persona);
  if (configPath) args.push('--config', configPath);
  if (storageState) args.push('--storage-state', storageState);
  if (resolvedPromptFile) args.push('--prompt-file', resolvedPromptFile);
  if (modelAdaptive) args.push('--model-adaptive');
  if (navModel) args.push('--nav-model', navModel);
  if (navProvider) args.push('--nav-provider', navProvider);
  if (memoryConfig.enabled) args.push('--memory');
  if (memoryConfig.dir) args.push('--memory-dir', memoryConfig.dir);
  if (traceScoring) args.push('--trace-scoring');
  if (traceTtlDays) args.push('--trace-ttl-days', traceTtlDays);
  if (headless) args.push('--headless');
  if (debug) args.push('--debug');
  // Gen 30 R2: forward provider/base-url/api-key so multi-rep can route
  // through a custom LLM endpoint (e.g. router.tangle.tools). Without
  // this, the child uses OPENAI_API_KEY against api.openai.com and
  // ignores the caller's --base-url.
  if (providerOverride) args.push('--provider', providerOverride);
  if (baseUrlOverride) args.push('--base-url', baseUrlOverride);
  if (apiKeyOverride) args.push('--api-key', apiKeyOverride);

  const startedAt = new Date().toISOString();
  const proc = spawnSync('node', args, {
    cwd: rootDir,
    env: benchmarkSyncChildEnv(process.env),
    stdio: 'inherit',
  });
  const endedAt = new Date().toISOString();

  const reportPath = path.join(modeDir, 'report.json');
  let report = null;
  if (fs.existsSync(reportPath)) {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
  }

  const result = report?.results?.[0] ?? null;
  const artifactCheck = verifyModeArtifacts({
    scenarioId: path.basename(outBase),
    mode,
    modeDir,
    reportPath,
  });
  return {
    mode,
    startedAt,
    endedAt,
    exitCode: proc.status ?? 1,
    signal: proc.signal ?? null,
    reportPath,
    metrics: {
      passed: result?.verified === true,
      agentSuccess: result?.agentSuccess === true,
      durationMs: result?.durationMs ?? report?.summary?.totalDurationMs ?? null,
      turnsUsed: result?.turnsUsed ?? null,
      tokensUsed: result?.tokensUsed ?? null,
      inputTokens: result?.inputTokens ?? null,
      outputTokens: result?.outputTokens ?? null,
      estimatedCostUsd: result?.estimatedCostUsd ?? null,
      verdict: result?.verdict ?? null,
    },
    memory: memoryConfig,
    artifactCheck,
  };
}

const runs = modes.map(runMode);
const artifactChecks = runs.map((run) => run.artifactCheck);
const artifactSummary = summarizeArtifactChecks(artifactChecks);
const executionFailures = runs
  .filter((run) => run.exitCode !== 0)
  .map((run) => `${run.mode} exited with code ${run.exitCode}`);
const artifactFailures = formatArtifactCheckFailures(artifactChecks);

const full = runs.find((r) => r.mode === 'full-evidence');
const fast = runs.find((r) => r.mode === 'fast-explore');

const comparison = {
  speedupPercent: (
    full?.metrics?.durationMs && fast?.metrics?.durationMs
      ? ((full.metrics.durationMs - fast.metrics.durationMs) / full.metrics.durationMs) * 100
      : null
  ),
  tokenDeltaPercent: (
    full?.metrics?.tokensUsed && fast?.metrics?.tokensUsed
      ? ((full.metrics.tokensUsed - fast.metrics.tokensUsed) / full.metrics.tokensUsed) * 100
      : null
  ),
};

const summary = {
  generatedAt: new Date().toISOString(),
  gitSha: safeGitSha(rootDir),
  goal,
  url,
  allowedDomains,
  model,
  benchmarkProfile: benchmarkProfile.id,
  driverProfile: benchmarkProfile.driverProfile,
  configPath: configPath ?? null,
  promptFile: resolvedPromptFile ?? null,
  promptHash,
  persona,
  maxTurns,
  timeoutMs,
  selectedCase: resolvedCaseMeta,
  memory: {
    enabled: memory,
    isolation: memoryIsolation,
    memoryDir: memoryDir ?? null,
    memoryRoot: memoryRoot ?? null,
    memoryScopeId: memoryScopeId ?? null,
  },
  outputDir: outBase,
  runs,
  artifactChecks: artifactSummary,
  comparison,
};

const summaryPath = path.join(outBase, 'baseline-summary.json');
fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

console.log('\nMode baseline summary:');
for (const run of runs) {
  const m = run.metrics;
  console.log(
    `- ${run.mode}: exit=${run.exitCode} pass=${m.passed} durationMs=${m.durationMs} turns=${m.turnsUsed} tokens=${m.tokensUsed}`
  );
}
if (comparison.speedupPercent != null) {
  console.log(`- fast-explore speedup vs full-evidence: ${comparison.speedupPercent.toFixed(1)}%`);
}
if (comparison.tokenDeltaPercent != null) {
  console.log(`- fast-explore token reduction vs full-evidence: ${comparison.tokenDeltaPercent.toFixed(1)}%`);
}
console.log(`- artifacts: ${artifactSummary.passed}/${artifactSummary.total} mode checks passed`);
console.log(`- summary: ${summaryPath}`);

await syncBenchmarkOutput({
  rootDir,
  outPath: outBase,
  label: `${goal.slice(0, 80)} · mode baseline`,
});

if (executionFailures.length > 0 || artifactFailures.length > 0) {
  for (const failure of [...executionFailures, ...artifactFailures]) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function parseModes(input) {
  const raw = String(input || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const unique = [...new Set(raw)];
  if (unique.length === 0) {
    throw new Error('At least one mode is required via --modes.');
  }
  for (const mode of unique) {
    if (!allowedModes.has(mode)) {
      throw new Error(`Invalid mode "${mode}" in --modes. Expected one of: ${[...allowedModes].join(', ')}`);
    }
  }
  return unique;
}

function resolveMemoryConfig(options) {
  const enabled = options.enabled === true;
  if (!enabled || options.isolation === 'none') {
    return { enabled: false, isolation: options.isolation, dir: null };
  }

  if (options.isolation === 'per-run') {
    const scopeId = options.memoryScopeId || path.basename(options.outBase);
    const root = options.memoryRoot ? path.resolve(options.memoryRoot) : path.join(options.outBase, '_memory');
    const dir = path.join(root, scopeId, options.mode);
    return { enabled: true, isolation: options.isolation, dir };
  }

  const sharedDir = options.memoryDir
    ? path.resolve(options.memoryDir)
    : options.memoryRoot
      ? path.resolve(options.memoryRoot)
      : null;
  return { enabled: true, isolation: options.isolation || 'shared', dir: sharedDir };
}

function safeGitSha(cwd) {
  try {
    return execSync('git rev-parse HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

function parseDomainCsv(value) {
  if (!value) return undefined;
  const domains = String(value)
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return domains.length > 0 ? [...new Set(domains)] : undefined;
}
