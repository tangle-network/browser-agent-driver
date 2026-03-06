#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadLocalEnvFiles, assertApiKeyForModel } from './lib/env-loader.mjs';
import { readAndValidateStorageState, resolveStorageStatePath } from './lib/storage-state.mjs';
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
const configPath = path.resolve(getArg('config', './bench/scenarios/configs/supervisor-on.mjs'));
const model = getArg('model', 'gpt-5.2');
const existingRootArg = getArg('existing-root');
const outRoot = existingRootArg
  ? path.resolve(existingRootArg)
  : path.resolve(getArg('out', `./agent-results/tier2-repeat-gate-${Date.now()}`));
const repetitions = clampInt(getArg('repetitions', '3'), 1, 16);
const concurrency = clampInt(getArg('concurrency', '1'), 1, 8);
const minFullPassRate = Number.parseFloat(getArg('min-full-pass-rate', '1'));
const minFastPassRate = Number.parseFloat(getArg('min-fast-pass-rate', '1'));
const maxAvgTurns = Number.parseFloat(getArg('max-avg-turns', '45'));
const maxAvgDurationMs = Number.parseFloat(getArg('max-avg-duration-ms', '300000'));
const storageStateArg = resolveStorageStatePath(getArg('storage-state'));

loadLocalEnvFiles(rootDir);
assertApiKeyForModel(model);

if (!fs.existsSync(casesPath)) {
  console.error(`Cases file not found: ${casesPath}`);
  process.exit(1);
}
if (!fs.existsSync(configPath)) {
  console.error(`Config file not found: ${configPath}`);
  process.exit(1);
}

let resolvedStorageState = undefined;
if (!existingRootArg) {
  if (!storageStateArg) {
    console.error('--storage-state is required unless --existing-root is used.');
    process.exit(1);
  }
  try {
    resolvedStorageState = readAndValidateStorageState(path.resolve(storageStateArg)).path;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

fs.mkdirSync(outRoot, { recursive: true });

if (!existingRootArg) {
  for (let i = 1; i <= repetitions; i += 1) {
    const repOut = path.join(outRoot, `rep-${i}`);
    const exitCode = await spawnAndWait(
      'node',
      [
        'scripts/run-tier2-gate.mjs',
        '--cases', casesPath,
        '--config', configPath,
        '--model', model,
        '--out', repOut,
        '--storage-state', resolvedStorageState,
        '--concurrency', String(concurrency),
        '--min-full-pass-rate', String(minFullPassRate),
        '--min-fast-pass-rate', String(minFastPassRate),
        '--max-avg-turns', String(maxAvgTurns),
        '--max-avg-duration-ms', String(maxAvgDurationMs),
      ],
      { cwd: rootDir, env: benchmarkSyncChildEnv(process.env), stdio: 'inherit' },
    );
    if (exitCode !== 0) {
      console.error(`rep-${i} failed with exit code ${exitCode}`);
      process.exit(exitCode);
    }
  }
}

const repDirs = fs.readdirSync(outRoot)
  .filter((name) => /^rep-\d+$/.test(name))
  .sort((a, b) => numericSuffix(a) - numericSuffix(b));

if (repDirs.length === 0) {
  console.error(`No rep-* directories found under ${outRoot}`);
  process.exit(1);
}

const summaries = [];
for (const rep of repDirs) {
  const summaryPath = path.join(outRoot, rep, 'tier2-gate-summary.json');
  if (!fs.existsSync(summaryPath)) {
    console.error(`Missing tier2 summary: ${summaryPath}`);
    process.exit(1);
  }
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));
  summaries.push({ rep, summary });
}

const scenarioMap = new Map();
for (const { rep, summary } of summaries) {
  for (const scenario of summary.scenarios ?? []) {
    const full = scenario.full ?? {};
    const fast = scenario.fast ?? {};
    const entry = scenarioMap.get(scenario.scenarioId) ?? {
      scenarioId: scenario.scenarioId,
      scenarioName: scenario.scenarioName,
      full: [],
      fast: [],
    };
    entry.full.push({
      rep,
      passed: toBinaryPass(full) === 1,
      turnsUsed: Number(full.turnsUsed ?? 0),
      durationMs: Number(full.durationMs ?? 0),
      tokensUsed: Number(full.tokensUsed ?? 0),
    });
    entry.fast.push({
      rep,
      passed: toBinaryPass(fast) === 1,
      turnsUsed: Number(fast.turnsUsed ?? 0),
      durationMs: Number(fast.durationMs ?? 0),
      tokensUsed: Number(fast.tokensUsed ?? 0),
    });
    scenarioMap.set(scenario.scenarioId, entry);
  }
}

const scenarios = Array.from(scenarioMap.values()).map((scenario) => ({
  scenarioId: scenario.scenarioId,
  scenarioName: scenario.scenarioName,
  fullEvidence: summarizeModeRows(scenario.full),
  fastExplore: summarizeModeRows(scenario.fast),
})).sort((a, b) => a.scenarioId.localeCompare(b.scenarioId));

const repeatedSummary = {
  generatedAt: new Date().toISOString(),
  mode: 'tier2-repeat-gate',
  outRoot,
  casesPath,
  configPath,
  model,
  repetitions: repDirs.length,
  thresholds: {
    minFullPassRate,
    minFastPassRate,
    maxAvgTurns,
    maxAvgDurationMs,
  },
  scenarios,
  passed: scenarios.every((scenario) =>
    scenario.fullEvidence.passRate >= minFullPassRate &&
    scenario.fastExplore.passRate >= minFastPassRate &&
    scenario.fullEvidence.avgTurns <= maxAvgTurns &&
    scenario.fastExplore.avgTurns <= maxAvgTurns &&
    scenario.fullEvidence.avgDurationMs <= maxAvgDurationMs &&
    scenario.fastExplore.avgDurationMs <= maxAvgDurationMs,
  ),
};

const summaryJsonPath = path.join(outRoot, 'tier2-repeat-summary.json');
const summaryMdPath = path.join(outRoot, 'tier2-repeat-summary.md');
fs.writeFileSync(summaryJsonPath, `${JSON.stringify(repeatedSummary, null, 2)}\n`);
fs.writeFileSync(summaryMdPath, renderMarkdown(repeatedSummary));

console.log(`\nTier2 repeated summary: ${summaryJsonPath}`);
console.log(`Tier2 repeated markdown: ${summaryMdPath}`);

await syncBenchmarkOutput({
  rootDir,
  outPath: outRoot,
  label: `${path.basename(casesPath)} · tier2 repeat gate`,
});

if (!repeatedSummary.passed) {
  process.exit(1);
}
console.log('Tier2 repeated gate PASSED');

function summarizeModeRows(rows) {
  return {
    repetitions: rows.length,
    passRate: rows.length ? rows.filter((row) => row.passed).length / rows.length : 0,
    avgTurns: mean(rows.map((row) => row.turnsUsed)),
    avgDurationMs: mean(rows.map((row) => row.durationMs)),
    avgTokens: mean(rows.map((row) => row.tokensUsed)),
    medianTurns: median(rows.map((row) => row.turnsUsed)),
    medianDurationMs: median(rows.map((row) => row.durationMs)),
    medianTokens: median(rows.map((row) => row.tokensUsed)),
  };
}

function renderMarkdown(summary) {
  const lines = [];
  lines.push('# Tier2 Repeated Gate');
  lines.push('');
  lines.push(`- Passed: **${summary.passed ? 'yes' : 'no'}**`);
  lines.push(`- Generated: ${summary.generatedAt}`);
  lines.push(`- Cases: \`${summary.casesPath}\``);
  lines.push(`- Config: \`${summary.configPath}\``);
  lines.push(`- Repetitions: ${summary.repetitions}`);
  lines.push('');
  lines.push('| Scenario | Full Pass | Fast Pass | Full Median Duration | Fast Median Duration |');
  lines.push('| --- | ---: | ---: | ---: | ---: |');
  for (const scenario of summary.scenarios) {
    lines.push(
      `| ${scenario.scenarioId} | ${pct(scenario.fullEvidence.passRate)} | ${pct(scenario.fastExplore.passRate)} | ${fmtMs(scenario.fullEvidence.medianDurationMs)} | ${fmtMs(scenario.fastExplore.medianDurationMs)} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function clampInt(value, min, max) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

function numericSuffix(value) {
  const match = value.match(/(\d+)$/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function fmtMs(value) {
  return `${(value / 1000).toFixed(1)}s`;
}

function toBinaryPass(metrics) {
  return metrics?.passed ? 1 : 0;
}

function spawnAndWait(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}
