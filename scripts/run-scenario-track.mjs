#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import { assertApiKeyForModel, loadLocalEnvFiles } from './lib/env-loader.mjs';
import { resolveBenchmarkProfile } from './lib/benchmark-profiles.mjs';
import { formatArtifactCheckFailures, summarizeArtifactChecks, verifyScenarioArtifacts } from './lib/artifact-completeness.mjs';
import { benchmarkSyncChildEnv, syncBenchmarkOutput } from './lib/abd-benchmark-sync.mjs';

const argv = process.argv.slice(2);
const getArg = (name, fallback = undefined) => {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  if (idx === argv.length - 1) return 'true';
  return argv[idx + 1];
};

const rootDir = path.resolve(path.join(new URL('.', import.meta.url).pathname, '..'));
const casesPath = path.resolve(getArg('cases', './bench/scenarios/cases/staging-auth-ai-tangle.json'));
const model = getArg('model', 'gpt-5.2');
const configPath = getArg('config');
const storageState = getArg('storage-state');
const fixtureBaseUrl = getArg('fixture-base-url');
const concurrency = clampInt(getArg('concurrency', '1'), 1, 32);
const outRoot = path.resolve(getArg('out', `./agent-results/track-${Date.now()}`));
const benchmarkProfileId = getArg('benchmark-profile', 'default');
const benchmarkProfile = resolveBenchmarkProfile(benchmarkProfileId);
const persona = getArg('persona', 'auto');
const modelAdaptive = argv.includes('--model-adaptive');
const navModel = getArg('nav-model');
const navProvider = getArg('nav-provider');
const providerOverride = getArg('provider');
const baseUrlOverride = getArg('base-url');
const apiKeyOverride = getArg('api-key');
const memory = argv.includes('--memory');
const memoryDir = getArg('memory-dir');
const memoryRoot = getArg('memory-root');
const memoryIsolation = getArg('memory-isolation', 'shared');
const memoryScopeId = getArg('memory-scope-id');
const promptFile = getArg('prompt-file');
const traceScoring = argv.includes('--trace-scoring');
const traceTtlDays = getArg('trace-ttl-days');
const modes = getArg('modes');
const headless = argv.includes('--headless');
const allowedMemoryIsolation = new Set(['none', 'shared', 'per-run']);

loadLocalEnvFiles(rootDir);
// Skip the env-var assertion when the caller supplied credentials via flags
// (--api-key + --base-url is the production sandbox / router path). Honor
// explicit flags first; fall back to the env check only when nothing is set.
if (!apiKeyOverride && !baseUrlOverride) {
  assertApiKeyForModel(model);
}
if (!allowedMemoryIsolation.has(String(memoryIsolation))) {
  throw new Error(`Invalid --memory-isolation value "${memoryIsolation}". Expected one of: none, shared, per-run`);
}

if (!fs.existsSync(casesPath)) {
  console.error(`Cases file not found: ${casesPath}`);
  process.exit(1);
}

const cases = JSON.parse(fs.readFileSync(casesPath, 'utf-8'));
if (!Array.isArray(cases) || cases.length === 0) {
  console.error('Cases file must be a non-empty JSON array.');
  process.exit(1);
}

fs.mkdirSync(outRoot, { recursive: true });
const jobs = cases.map((scenario, index) => {
  const rawUrl = scenario.startUrl ?? scenario.url;
  const startUrl = typeof rawUrl === 'string'
    ? rawUrl.replace('__FIXTURE_BASE_URL__', fixtureBaseUrl ?? '__FIXTURE_BASE_URL__')
    : rawUrl;
  if (String(startUrl).includes('__FIXTURE_BASE_URL__')) {
    throw new Error(
      `Scenario "${scenario.id ?? scenario.name ?? 'unknown'}" contains __FIXTURE_BASE_URL__ but --fixture-base-url was not provided.`,
    );
  }

  const scenarioSlug = String(scenario.id || scenario.name || `scenario-${index + 1}`)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-');
  const scenarioDir = path.join(outRoot, scenarioSlug);
  fs.mkdirSync(scenarioDir, { recursive: true });

  return {
    scenario,
    scenarioSlug,
    startUrl,
    scenarioDir,
    index,
  };
});

let fatalAbortReason = null;
const results = await runPool(jobs, concurrency, async (job) => {
  const { scenario, scenarioSlug, startUrl, scenarioDir } = job;
  const args = [
    'scripts/run-mode-baseline.mjs',
    '--goal', scenario.goal,
    '--url', startUrl,
    '--model', model,
    '--max-turns', String(scenario.maxTurns ?? 30),
    '--timeout-ms', String(scenario.timeoutMs ?? 600000),
    '--out', scenarioDir,
    '--benchmark-profile', benchmarkProfile.id,
    '--persona', persona,
  ];
  if (configPath) args.push('--config', configPath);
  if (modes) args.push('--modes', modes);
  if (storageState) args.push('--storage-state', storageState);
  if (promptFile) args.push('--prompt-file', path.resolve(promptFile));
  if (modelAdaptive) args.push('--model-adaptive');
  if (navModel) args.push('--nav-model', navModel);
  if (navProvider) args.push('--nav-provider', navProvider);
  if (memory) args.push('--memory');
  if (memoryDir) args.push('--memory-dir', memoryDir);
  if (memoryRoot) args.push('--memory-root', memoryRoot);
  if (memoryIsolation) args.push('--memory-isolation', memoryIsolation);
  if (memoryIsolation === 'per-run') {
    const scopePrefix = memoryScopeId ? `${memoryScopeId}-` : '';
    args.push('--memory-scope-id', `${scopePrefix}${scenarioSlug}`);
  }
  if (traceScoring) args.push('--trace-scoring');
  if (traceTtlDays) args.push('--trace-ttl-days', traceTtlDays);
  if (headless) args.push('--headless');
  // Gen 30 R3: forward provider/base-url/api-key so scenario-track can route
  // through a custom LLM endpoint (router.tangle.tools, LiteLLM, etc.).
  // Mirrors the fix Gen 30 R2 shipped to run-multi-rep and run-mode-baseline.
  if (providerOverride) args.push('--provider', providerOverride);
  if (baseUrlOverride) args.push('--base-url', baseUrlOverride);
  if (apiKeyOverride) args.push('--api-key', apiKeyOverride);
  if (Array.isArray(scenario.allowedDomains) && scenario.allowedDomains.length > 0) {
    args.push('--allowed-domains', scenario.allowedDomains.join(','));
  }

  const exitCode = await spawnAndWait('node', args, {
    cwd: rootDir,
    env: benchmarkSyncChildEnv(process.env),
    stdio: 'inherit',
  });

  const summaryPath = path.join(scenarioDir, 'baseline-summary.json');
  let summary = null;
  if (fs.existsSync(summaryPath)) {
    summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));
  }
  const fatalProviderFailure = detectFatalProviderFailure(summary);
  if (fatalProviderFailure && !fatalAbortReason) {
    fatalAbortReason = `${scenario.id ?? scenarioSlug}: ${fatalProviderFailure}`;
    console.error(`Fatal provider failure; stopping remaining scenarios: ${fatalAbortReason}`);
  }

  return {
    scenarioId: scenario.id ?? scenarioSlug,
    scenarioName: scenario.name ?? scenario.goal.slice(0, 100),
    exitCode,
    summaryPath,
    summary,
  };
});
const completedResults = results.filter(Boolean);

const artifactRows = [];
for (const result of completedResults) {
  const checks = Array.isArray(result.summary?.artifactChecks?.rows) && result.summary.artifactChecks.rows.length > 0
    ? result.summary.artifactChecks.rows
    : verifyScenarioArtifacts({
      scenarioId: result.scenarioId,
      summaryPath: result.summaryPath,
      runs: result.summary?.runs ?? [],
    });
  result.artifactChecks = checks;
  artifactRows.push(...checks);
}

const artifactChecks = summarizeArtifactChecks(artifactRows);
const executionFailures = completedResults
  .filter((result) => result.exitCode !== 0)
  .map((result) => `${result.scenarioId} exited with code ${result.exitCode}`);
if (fatalAbortReason) {
  executionFailures.unshift(`fatal provider failure: ${fatalAbortReason}`);
}
const artifactFailures = formatArtifactCheckFailures(artifactRows);

// Compute total cost across all runs
let totalTokens = 0;
let totalInputTokens = 0;
let totalOutputTokens = 0;
let totalCostUsd = 0;
for (const result of completedResults) {
  for (const run of result.summary?.runs ?? []) {
    const m = run?.metrics ?? {};
    totalTokens += Number(m.tokensUsed ?? 0);
    totalInputTokens += Number(m.inputTokens ?? 0);
    totalOutputTokens += Number(m.outputTokens ?? 0);
    totalCostUsd += Number(m.estimatedCostUsd ?? 0);
  }
}

const aggregate = {
  generatedAt: new Date().toISOString(),
  gitSha: safeGitSha(rootDir),
  casesPath,
  outputDir: outRoot,
  benchmarkProfile: benchmarkProfile.id,
  driverProfile: benchmarkProfile.driverProfile,
  promptFile: promptFile ? path.resolve(promptFile) : null,
  memory: {
    enabled: memory,
    isolation: memoryIsolation,
    memoryDir: memoryDir ?? null,
    memoryRoot: memoryRoot ?? null,
    memoryScopeId: memoryScopeId ?? null,
  },
  totalScenarios: results.length,
  completedScenarios: completedResults.length,
  aborted: Boolean(fatalAbortReason),
  abortReason: fatalAbortReason,
  totalTokens,
  totalInputTokens: totalInputTokens || undefined,
  totalOutputTokens: totalOutputTokens || undefined,
  totalCostUsd: totalCostUsd ? Number(totalCostUsd.toFixed(4)) : undefined,
  artifactChecks,
  results: completedResults,
};

const aggregatePath = path.join(outRoot, 'track-summary.json');
fs.writeFileSync(aggregatePath, `${JSON.stringify(aggregate, null, 2)}\n`);
console.log(`\nTrack summary: ${aggregatePath}`);
if (totalCostUsd > 0) {
  console.log(`Total cost: $${totalCostUsd.toFixed(2)} (${totalTokens.toLocaleString()} tokens: ${totalInputTokens.toLocaleString()} input + ${totalOutputTokens.toLocaleString()} output)`);
}

await syncBenchmarkOutput({
  rootDir,
  outPath: outRoot,
  label: `${path.basename(casesPath)} · scenario track`,
});

if (executionFailures.length > 0 || artifactFailures.length > 0) {
  for (const failure of [...executionFailures, ...artifactFailures]) {
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
      if (fatalAbortReason) return;
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  const workerCount = Math.min(limit, Math.max(1, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => runner()));
  return results;
}

function detectFatalProviderFailure(summary) {
  const text = JSON.stringify(summary ?? '').toLowerCase();
  if (/\brequires credits\b/.test(text)) return 'model requires credits';
  if (/\binsufficient (?:credits|balance|quota)\b/.test(text)) return 'insufficient credits';
  if (/\bbilling\b.*\b(?:limit|quota|credits?)\b/.test(text)) return 'billing limit';
  if (/\b(?:invalid|missing|expired|unauthorized)\b.*\b(?:api[-_ ]?key|token|credentials?)\b/.test(text)) return 'invalid credentials';
  if (/\b401\b.*\b(?:unauthorized|api[-_ ]?key|token|credentials?)\b/.test(text)) return 'unauthorized credentials';
  if (/\b403\b.*\b(?:forbidden|api[-_ ]?key|token|credentials?)\b/.test(text)) return 'forbidden credentials';
  return null;
}

function safeGitSha(cwd) {
  try {
    return execSync('git rev-parse HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}
