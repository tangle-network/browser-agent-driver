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

const rootDir = path.resolve(path.join(new URL('.', import.meta.url).pathname, '..'));
const casesPath = path.resolve(getArg('cases', './bench/scenarios/cases/staging-auth-ai-tangle.json'));
const model = getArg('model', 'gpt-5.2');
const storageState = getArg('storage-state');
const outRoot = path.resolve(getArg('out', `./agent-results/track-${Date.now()}`));
const persona = getArg('persona', 'auto');
const modelAdaptive = argv.includes('--model-adaptive');
const navModel = getArg('nav-model');
const navProvider = getArg('nav-provider');
const memory = argv.includes('--memory');
const memoryDir = getArg('memory-dir');
const traceScoring = argv.includes('--trace-scoring');
const traceTtlDays = getArg('trace-ttl-days');

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
const results = [];

for (const scenario of cases) {
  const scenarioSlug = String(scenario.id || scenario.name || 'scenario')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-');
  const scenarioDir = path.join(outRoot, scenarioSlug);
  fs.mkdirSync(scenarioDir, { recursive: true });

  const args = [
    'scripts/run-mode-baseline.mjs',
    '--goal', scenario.goal,
    '--url', scenario.startUrl,
    '--model', model,
    '--max-turns', String(scenario.maxTurns ?? 30),
    '--out', scenarioDir,
    '--persona', persona,
  ];
  if (storageState) args.push('--storage-state', storageState);
  if (modelAdaptive) args.push('--model-adaptive');
  if (navModel) args.push('--nav-model', navModel);
  if (navProvider) args.push('--nav-provider', navProvider);
  if (memory) args.push('--memory');
  if (memoryDir) args.push('--memory-dir', memoryDir);
  if (traceScoring) args.push('--trace-scoring');
  if (traceTtlDays) args.push('--trace-ttl-days', traceTtlDays);

  const proc = spawnSync('node', args, {
    cwd: rootDir,
    env: process.env,
    stdio: 'inherit',
  });

  const summaryPath = path.join(scenarioDir, 'baseline-summary.json');
  let summary = null;
  if (fs.existsSync(summaryPath)) {
    summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));
  }

  results.push({
    scenarioId: scenario.id ?? scenarioSlug,
    scenarioName: scenario.name ?? scenario.goal.slice(0, 100),
    exitCode: proc.status ?? 1,
    summaryPath,
    summary,
  });
}

const aggregate = {
  generatedAt: new Date().toISOString(),
  casesPath,
  outputDir: outRoot,
  totalScenarios: results.length,
  results,
};

const aggregatePath = path.join(outRoot, 'track-summary.json');
fs.writeFileSync(aggregatePath, JSON.stringify(aggregate, null, 2));
console.log(`\nTrack summary: ${aggregatePath}`);
