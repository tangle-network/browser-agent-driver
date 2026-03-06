#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadLocalEnvFiles, assertApiKeyForModel } from './lib/env-loader.mjs';
import { benchmarkSyncChildEnv, syncBenchmarkOutput } from './lib/abd-benchmark-sync.mjs';

const argv = process.argv.slice(2);
const getArg = (name, fallback = undefined) => {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  if (idx === argv.length - 1) return 'true';
  return argv[idx + 1];
};

const rootDir = path.resolve(path.join(new URL('.', import.meta.url).pathname, '..'));
const casesPath = path.resolve(getArg('cases', './bench/scenarios/cases/webbench-reachable3-max20-timeout120.json'));
const model = getArg('model', 'gpt-5.2');
const existingRootArg = getArg('existing-root');
const outRoot = existingRootArg
  ? path.resolve(existingRootArg)
  : path.resolve(getArg('out', `./agent-results/tier3-gate-${Date.now()}`));
const benchmarkProfile = getArg('benchmark-profile', 'webbench');
const repetitions = clampInt(getArg('repetitions', '5'), 1, 32);
const concurrency = clampInt(getArg('concurrency', '1'), 1, 8);
const modes = getArg('modes', 'fast-explore');
const minCasePassRate = Number.parseFloat(getArg('min-case-pass-rate', '0.8'));
const minOverallPassRate = Number.parseFloat(getArg('min-overall-pass-rate', '0.8'));
const requireArtifacts = getArg('require-artifacts', 'true') !== 'false';

loadLocalEnvFiles(rootDir);
assertApiKeyForModel(model);

if (!fs.existsSync(casesPath)) {
  console.error(`Cases file not found: ${casesPath}`);
  process.exit(1);
}

fs.mkdirSync(outRoot, { recursive: true });

if (!existingRootArg) {
  for (let i = 1; i <= repetitions; i += 1) {
    const repOut = path.join(outRoot, `rep-${i}`);
    const exitCode = await spawnAndWait(
      'node',
      [
        'scripts/run-scenario-track.mjs',
        '--cases', casesPath,
        '--benchmark-profile', benchmarkProfile,
        '--model', model,
        '--modes', modes,
        '--concurrency', String(concurrency),
        '--out', repOut,
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

const trackRows = [];
const caseStats = new Map();
const artifactRows = [];
for (const rep of repDirs) {
  const trackSummaryPath = path.join(outRoot, rep, 'track-summary.json');
  if (!fs.existsSync(trackSummaryPath)) {
    console.error(`Missing track summary: ${trackSummaryPath}`);
    process.exit(1);
  }
  const trackSummary = JSON.parse(fs.readFileSync(trackSummaryPath, 'utf-8'));
  for (const result of trackSummary.results ?? []) {
    const run = result.summary?.runs?.[0];
    if (!run?.metrics) continue;
    const row = {
      rep,
      scenarioId: result.scenarioId,
      scenarioName: result.scenarioName,
      mode: run.mode,
      passed: Boolean(run.metrics.passed),
      durationMs: Number(run.metrics.durationMs ?? 0),
      turnsUsed: Number(run.metrics.turnsUsed ?? 0),
      tokensUsed: Number(run.metrics.tokensUsed ?? 0),
      summaryPath: result.summaryPath,
      reportPath: run.reportPath,
      artifactCheck: run.artifactCheck ?? null,
    };
    trackRows.push(row);
    if (!caseStats.has(result.scenarioId)) {
      caseStats.set(result.scenarioId, {
        scenarioName: result.scenarioName,
        rows: [],
      });
    }
    caseStats.get(result.scenarioId).rows.push(row);
    if (row.artifactCheck) artifactRows.push({ rep, scenarioId: result.scenarioId, ...row.artifactCheck });
  }
}

const cases = Array.from(caseStats.entries()).map(([scenarioId, data]) => {
  const passCount = data.rows.filter((row) => row.passed).length;
  return {
    scenarioId,
    scenarioName: data.scenarioName,
    repetitions: data.rows.length,
    passCount,
    passRate: safeDiv(passCount, data.rows.length),
    medianDurationMs: median(data.rows.map((row) => row.durationMs)),
    medianTurns: median(data.rows.map((row) => row.turnsUsed)),
    medianTokens: median(data.rows.map((row) => row.tokensUsed)),
    rows: data.rows,
  };
}).sort((a, b) => a.scenarioId.localeCompare(b.scenarioId));

const overallPassRate = safeDiv(
  trackRows.filter((row) => row.passed).length,
  trackRows.length,
);
const artifactFailures = requireArtifacts
  ? artifactRows.filter((row) => row.passed === false)
  : [];
const gateFailures = [];
for (const scenario of cases) {
  if (scenario.passRate < minCasePassRate) {
    gateFailures.push(
      `${scenario.scenarioId} pass rate ${pct(scenario.passRate)} below threshold ${pct(minCasePassRate)}`,
    );
  }
}
if (overallPassRate < minOverallPassRate) {
  gateFailures.push(`overall pass rate ${pct(overallPassRate)} below threshold ${pct(minOverallPassRate)}`);
}
for (const row of artifactFailures) {
  gateFailures.push(`${row.scenarioId} (${row.mode}) artifact check failed: ${(row.failures ?? []).join('; ')}`);
}

const summary = {
  generatedAt: new Date().toISOString(),
  mode: 'tier3-public-web-gate',
  rootDir,
  outRoot,
  casesPath,
  model,
  benchmarkProfile,
  repetitions: repDirs.length,
  thresholds: {
    minCasePassRate,
    minOverallPassRate,
    requireArtifacts,
  },
  overall: {
    passRate: overallPassRate,
    scenarios: cases.length,
    runs: trackRows.length,
  },
  cases,
  artifactChecks: {
    total: artifactRows.length,
    passed: artifactRows.filter((row) => row.passed !== false).length,
    failed: artifactFailures.length,
    rows: artifactRows,
  },
  gateFailures,
  passed: gateFailures.length === 0,
};

const summaryJsonPath = path.join(outRoot, 'tier3-gate-summary.json');
const summaryMdPath = path.join(outRoot, 'tier3-gate-summary.md');
fs.writeFileSync(summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`);
fs.writeFileSync(summaryMdPath, renderMarkdown(summary));

console.log(`\nTier3 gate summary: ${summaryJsonPath}`);
console.log(`Tier3 gate markdown: ${summaryMdPath}`);

await syncBenchmarkOutput({
  rootDir,
  outPath: outRoot,
  label: `${path.basename(casesPath)} · tier3 gate`,
});

if (gateFailures.length > 0) {
  for (const failure of gateFailures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('Tier3 public-web gate PASSED');

function renderMarkdown(summary) {
  const lines = [];
  lines.push('# Tier3 Public-Web Gate');
  lines.push('');
  lines.push(`- Passed: **${summary.passed ? 'yes' : 'no'}**`);
  lines.push(`- Generated: ${summary.generatedAt}`);
  lines.push(`- Cases: \`${summary.casesPath}\``);
  lines.push(`- Output: \`${summary.outRoot}\``);
  lines.push(`- Model: \`${summary.model}\``);
  lines.push(`- Repetitions: ${summary.repetitions}`);
  lines.push(`- Overall pass rate: ${pct(summary.overall.passRate)}`);
  lines.push('');
  lines.push('| Scenario | Pass Rate | Median Duration | Median Turns | Median Tokens |');
  lines.push('| --- | --- | ---: | ---: | ---: |');
  for (const scenario of summary.cases) {
    lines.push(
      `| ${scenario.scenarioId} | ${pct(scenario.passRate)} | ${fmtMs(scenario.medianDurationMs)} | ${scenario.medianTurns} | ${fmtInt(scenario.medianTokens)} |`,
    );
  }
  if (summary.gateFailures.length > 0) {
    lines.push('');
    lines.push('## Failures');
    lines.push('');
    for (const failure of summary.gateFailures) lines.push(`- ${failure}`);
  }
  return `${lines.join('\n')}\n`;
}

function clampInt(value, min, max) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

function safeDiv(a, b) {
  return b === 0 ? 0 : a / b;
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

function fmtInt(value) {
  return new Intl.NumberFormat('en-US').format(Math.round(value));
}

function numericSuffix(value) {
  const match = value.match(/(\d+)$/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function spawnAndWait(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}
