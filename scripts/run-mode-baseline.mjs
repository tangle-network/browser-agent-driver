#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const getArg = (name, fallback = undefined) => {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  if (idx === argv.length - 1) return 'true';
  return argv[idx + 1];
};

const hasFlag = (name) => argv.includes(`--${name}`);
const rootDir = path.resolve(path.join(new URL('.', import.meta.url).pathname, '..'));

const goal = getArg('goal', 'Navigate to /partner/coinbase and verify Coinbase templates are visible.');
const url = getArg('url', 'https://ai.tangle.tools');
const model = getArg('model', 'gpt-5.2');
const persona = getArg('persona', 'auto');
const storageState = getArg('storage-state');
const maxTurns = Number.parseInt(getArg('max-turns', '35'), 10);
const runId = `${Date.now()}`;
const outBase = path.resolve(getArg('out', `./agent-results/mode-baseline-${runId}`));
const debug = hasFlag('debug');
const modelAdaptive = hasFlag('model-adaptive');
const navModel = getArg('nav-model');
const navProvider = getArg('nav-provider');
const memory = hasFlag('memory');
const memoryDir = getArg('memory-dir');
const traceScoring = hasFlag('trace-scoring');
const traceTtlDays = getArg('trace-ttl-days');

fs.mkdirSync(outBase, { recursive: true });

const modes = ['full-evidence', 'fast-explore'];

function runMode(mode) {
  const modeDir = path.join(outBase, mode);
  const args = [
    'dist/cli.js',
    'run',
    '--goal', goal,
    '--url', url,
    '--model', model,
    '--mode', mode,
    '--max-turns', String(maxTurns),
    '--sink', modeDir,
  ];
  if (persona) args.push('--persona', persona);
  if (storageState) args.push('--storage-state', storageState);
  if (modelAdaptive) args.push('--model-adaptive');
  if (navModel) args.push('--nav-model', navModel);
  if (navProvider) args.push('--nav-provider', navProvider);
  if (memory) args.push('--memory');
  if (memoryDir) args.push('--memory-dir', memoryDir);
  if (traceScoring) args.push('--trace-scoring');
  if (traceTtlDays) args.push('--trace-ttl-days', traceTtlDays);
  if (debug) args.push('--debug');

  const startedAt = new Date().toISOString();
  const proc = spawnSync('node', args, {
    cwd: rootDir,
    env: process.env,
    stdio: 'inherit',
  });
  const endedAt = new Date().toISOString();

  const reportPath = path.join(modeDir, 'report.json');
  let report = null;
  if (fs.existsSync(reportPath)) {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
  }

  const result = report?.results?.[0] ?? null;
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
      verdict: result?.verdict ?? null,
    },
  };
}

const runs = modes.map(runMode);

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
  goal,
  url,
  model,
  persona,
  maxTurns,
  outputDir: outBase,
  runs,
  comparison,
};

const summaryPath = path.join(outBase, 'baseline-summary.json');
fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

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
console.log(`- summary: ${summaryPath}`);
