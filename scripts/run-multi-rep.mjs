#!/usr/bin/env node
/**
 * Multi-rep harness for single-config validation under the Measurement
 * Rigor rules in CLAUDE.md.
 *
 * Runs `scripts/run-mode-baseline.mjs` N times against one scenario+config
 * and emits the canonical mean/min/max table for: wall-time, turns,
 * tokens, cost. NO speedup or improvement claim should be filed without
 * this (or `ab:experiment` for A/B comparisons).
 *
 * Usage:
 *   node scripts/run-multi-rep.mjs \
 *     --cases bench/scenarios/cases/long-form-dashboard.json \
 *     --config bench/scenarios/configs/planner-on.mjs \
 *     --reps 3 \
 *     --modes fast-explore \
 *     --label gen7-planner \
 *     --out agent-results/multi-rep-gen7
 *
 * Output: <out>/multi-rep-summary.json + multi-rep-summary.md
 *
 * Exit codes: 0 = ran (any pass rate), 1 = subprocess failure.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import { startStaticFixtureServer } from './lib/static-fixture-server.mjs';

const argv = process.argv.slice(2);
const getArg = (name, fallback = undefined) => {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  if (idx === argv.length - 1) return 'true';
  return argv[idx + 1];
};
const hasFlag = (name) => argv.includes(`--${name}`);
const rootDir = path.resolve(path.join(new URL('.', import.meta.url).pathname, '..'));

const casesPath = getArg('cases');
const configPath = getArg('config');
const reps = Math.max(1, Number.parseInt(getArg('reps', '3'), 10));
const allowQuickCheck = hasFlag('allow-quick-check');
const modes = getArg('modes', 'fast-explore,full-evidence');
const model = getArg('model', 'gpt-5.2');
const label = getArg('label', 'multi-rep');
const benchmarkProfile = getArg('benchmark-profile', 'default');
const outRoot = path.resolve(getArg('out', `./agent-results/multi-rep-${Date.now()}`));
const goal = getArg('goal');
const url = getArg('url');
const planner = hasFlag('planner');
const memoryIsolation = getArg('memory-isolation', 'per-run');
const fixtureBaseUrlArg = getArg('fixture-base-url');
const providerOverride = getArg('provider');
const baseUrlOverride = getArg('base-url');
const apiKeyOverride = getArg('api-key');
let fixtureBaseUrl = fixtureBaseUrlArg;
let fixtureServer = null;

if (!casesPath && !(goal && url)) {
  console.error('multi-rep: provide --cases <path> OR both --goal and --url');
  process.exit(1);
}
if (reps < 3 && !allowQuickCheck) {
  console.error(
    `multi-rep: ERROR reps=${reps} but CLAUDE.md mandates ≥3 reps for any speed/turn/cost claim.\n` +
    `  - For genuine validation: run with --reps 3 (or more)\n` +
    `  - For a quick smoke check that you will NOT cite anywhere: pass --allow-quick-check`,
  );
  process.exit(2);
}
if (reps < 3 && allowQuickCheck) {
  console.warn(`multi-rep: --allow-quick-check is on (reps=${reps}). DO NOT cite this run as validation.`);
}

fs.mkdirSync(outRoot, { recursive: true });

// Auto-start the static fixture server when the cases reference __FIXTURE_BASE_URL__
// and the caller didn't provide one explicitly. Mirrors the tier1 gate behavior.
if (!fixtureBaseUrl && casesPath) {
  const casesAbs = path.resolve(casesPath);
  if (fs.existsSync(casesAbs)) {
    const raw = fs.readFileSync(casesAbs, 'utf-8');
    if (raw.includes('__FIXTURE_BASE_URL__')) {
      const fixturesDir = path.join(rootDir, 'bench', 'fixtures');
      fixtureServer = await startStaticFixtureServer(fixturesDir);
      fixtureBaseUrl = fixtureServer.baseUrl;
      console.log(`multi-rep: started fixture server at ${fixtureBaseUrl} (root: ${fixturesDir})`);
    }
  }
}

const repResults = [];
let anyFailed = false;
try {
for (let rep = 1; rep <= reps; rep++) {
  const repDir = path.join(outRoot, `rep-${String(rep).padStart(3, '0')}`);
  fs.mkdirSync(repDir, { recursive: true });
  console.log(`\n=== rep ${rep}/${reps} → ${repDir} ===`);

  const args = [
    'scripts/run-mode-baseline.mjs',
    '--out', repDir,
    '--model', model,
    '--modes', modes,
    '--benchmark-profile', benchmarkProfile,
    '--memory-isolation', memoryIsolation,
    '--memory-scope-id', `${label}-rep${rep}`,
  ];
  if (casesPath) args.push('--cases', path.resolve(casesPath));
  if (goal) args.push('--goal', goal);
  if (url) args.push('--url', url);
  if (configPath) args.push('--config', path.resolve(configPath));
  if (planner) args.push('--planner');
  if (fixtureBaseUrl) args.push('--fixture-base-url', fixtureBaseUrl);
  // Gen 30 R2: forward provider/base-url/api-key to the per-rep baseline
  // so custom LLM endpoints (router.tangle.tools, LiteLLM, local models)
  // reach the child bad run.
  if (providerOverride) args.push('--provider', providerOverride);
  if (baseUrlOverride) args.push('--base-url', baseUrlOverride);
  if (apiKeyOverride) args.push('--api-key', apiKeyOverride);

  // CRITICAL: must be async spawn (not spawnSync). The fixture server lives
  // in this same process — spawnSync would block the event loop and the
  // child agent could not reach the fixture URL.
  const exitCode = await new Promise((resolve) => {
    const proc = spawn('node', args, {
      cwd: rootDir,
      env: process.env,
      stdio: 'inherit',
    });
    proc.on('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
    proc.on('error', (err) => {
      console.error(`multi-rep: rep ${rep} spawn error: ${err.message}`);
      resolve(1);
    });
  });

  if (exitCode !== 0) {
    anyFailed = true;
    console.error(`multi-rep: rep ${rep} subprocess exited ${exitCode}`);
  }

  const summaryPath = path.join(repDir, 'baseline-summary.json');
  if (!fs.existsSync(summaryPath)) {
    console.error(`multi-rep: rep ${rep} produced no baseline-summary.json — skipping`);
    repResults.push({ rep, ok: false, summaryPath: null });
    continue;
  }
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));
  repResults.push({ rep, ok: true, summaryPath, summary });
}
} finally {
  if (fixtureServer) {
    try { await fixtureServer.close(); } catch {}
  }
}

const byMode = new Map();
for (const r of repResults) {
  if (!r.ok) continue;
  for (const run of r.summary.runs ?? []) {
    if (!byMode.has(run.mode)) byMode.set(run.mode, []);
    byMode.get(run.mode).push({
      rep: r.rep,
      passed: run.metrics?.passed === true,
      durationMs: Number(run.metrics?.durationMs ?? 0),
      turnsUsed: Number(run.metrics?.turnsUsed ?? 0),
      tokensUsed: Number(run.metrics?.tokensUsed ?? 0),
      estimatedCostUsd: Number(run.metrics?.estimatedCostUsd ?? 0),
    });
  }
}

function stats(values) {
  if (values.length === 0) return { n: 0, mean: 0, min: 0, max: 0 };
  const n = values.length;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const min = Math.min(...values);
  const max = Math.max(...values);
  return { n, mean, min, max };
}

const perModeStats = {};
for (const [mode, runs] of byMode.entries()) {
  perModeStats[mode] = {
    reps: runs.length,
    passRate: runs.filter((r) => r.passed).length / runs.length,
    durationMs: stats(runs.map((r) => r.durationMs)),
    turnsUsed: stats(runs.map((r) => r.turnsUsed)),
    tokensUsed: stats(runs.map((r) => r.tokensUsed)),
    costUsd: stats(runs.map((r) => r.estimatedCostUsd)),
    rawRuns: runs,
  };
}

const aggregate = {
  generatedAt: new Date().toISOString(),
  label,
  gitSha: safeGitSha(),
  config: configPath ?? null,
  cases: casesPath ?? null,
  goal: goal ?? null,
  url: url ?? null,
  model,
  reps,
  benchmarkProfile,
  modes: modes.split(','),
  perModeStats,
  rigorWarnings: reps < 3 ? ['reps < 3 — CLAUDE.md mandates ≥3 for any speed claim'] : [],
};

const aggPath = path.join(outRoot, 'multi-rep-summary.json');
fs.writeFileSync(aggPath, `${JSON.stringify(aggregate, null, 2)}\n`);

const md = renderMarkdown(aggregate);
const mdPath = path.join(outRoot, 'multi-rep-summary.md');
fs.writeFileSync(mdPath, md);

console.log('\n' + md);
console.log(`\nMulti-rep summary: ${aggPath}`);
console.log(`Markdown report:   ${mdPath}`);

process.exit(anyFailed ? 1 : 0);

function renderMarkdown(agg) {
  const lines = [];
  lines.push(`# Multi-rep summary — ${agg.label}`);
  lines.push('');
  lines.push(`- Generated: ${agg.generatedAt}`);
  lines.push(`- Git SHA: ${agg.gitSha ?? 'unknown'}`);
  lines.push(`- Reps: ${agg.reps}`);
  lines.push(`- Model: ${agg.model}`);
  if (agg.config) lines.push(`- Config: ${agg.config}`);
  if (agg.cases) lines.push(`- Cases: ${agg.cases}`);
  if (agg.goal) lines.push(`- Goal: ${agg.goal}`);
  if (agg.url) lines.push(`- URL: ${agg.url}`);
  lines.push('');
  if (agg.rigorWarnings.length > 0) {
    lines.push('> ⚠ Rigor warnings:');
    for (const w of agg.rigorWarnings) lines.push(`> - ${w}`);
    lines.push('');
  }
  for (const [mode, s] of Object.entries(agg.perModeStats)) {
    lines.push(`## Mode: ${mode}`);
    lines.push('');
    lines.push(`Reps: ${s.reps} · Pass rate: ${(s.passRate * 100).toFixed(0)}%`);
    lines.push('');
    lines.push('| metric | mean | min | max | reps |');
    lines.push('|---|---:|---:|---:|---:|');
    lines.push(`| wall-time (s) | ${(s.durationMs.mean / 1000).toFixed(1)} | ${(s.durationMs.min / 1000).toFixed(1)} | ${(s.durationMs.max / 1000).toFixed(1)} | ${s.reps} |`);
    lines.push(`| turns | ${s.turnsUsed.mean.toFixed(1)} | ${s.turnsUsed.min} | ${s.turnsUsed.max} | ${s.reps} |`);
    lines.push(`| tokens | ${s.tokensUsed.mean.toFixed(0)} | ${s.tokensUsed.min} | ${s.tokensUsed.max} | ${s.reps} |`);
    lines.push(`| cost ($) | ${s.costUsd.mean.toFixed(4)} | ${s.costUsd.min.toFixed(4)} | ${s.costUsd.max.toFixed(4)} | ${s.reps} |`);
    lines.push('');
    lines.push('### Per-rep raw');
    lines.push('');
    lines.push('| rep | pass | wall (s) | turns | tokens | cost ($) |');
    lines.push('|---:|:---:|---:|---:|---:|---:|');
    for (const r of s.rawRuns) {
      lines.push(`| ${r.rep} | ${r.passed ? '✓' : '✗'} | ${(r.durationMs / 1000).toFixed(1)} | ${r.turnsUsed} | ${r.tokensUsed} | ${r.estimatedCostUsd.toFixed(4)} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function safeGitSha() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: rootDir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}
