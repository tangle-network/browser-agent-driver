#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readAndValidateStorageState, resolveStorageStatePath } from './lib/storage-state.mjs';
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
const profile = getArg('profile', 'smoke');
const model = getArg('model', 'gpt-5.2');
const outRoot = path.resolve(getArg('out', `./agent-results/local-${profile}-${Date.now()}`));
const storageState = resolveStorageStatePath(getArg('storage-state'));
const includeTier2 = hasFlag('include-tier2') || Boolean(storageState && profile === 'nightly');
const concurrency = getArg('concurrency', '1');

fs.mkdirSync(outRoot, { recursive: true });

const steps = buildSteps();
const results = [];

for (const step of steps) {
  console.log(`\n== ${step.name} ==`);
  const exitCode = await spawnAndWait(step.command, step.args, {
    cwd: rootDir,
    env: benchmarkSyncChildEnv(process.env),
    stdio: 'inherit',
  });
  results.push({ name: step.name, exitCode });
  if (exitCode !== 0) {
    console.error(`Step failed: ${step.name}`);
    process.exit(exitCode);
  }
}

const scorecardPath = path.join(outRoot, 'reliability-scorecard.json');
const scorecardMdPath = path.join(outRoot, 'reliability-scorecard.md');
const scorecardExit = await spawnAndWait(
  'node',
  [
    'scripts/reliability-scorecard.mjs',
    '--root', outRoot,
    '--out', scorecardPath,
    '--md', scorecardMdPath,
  ],
  { cwd: rootDir, env: benchmarkSyncChildEnv(process.env), stdio: 'inherit' },
);
if (scorecardExit !== 0) {
  process.exit(scorecardExit);
}

const trendPath = path.join(outRoot, 'reliability-trend.json');
const trendMdPath = path.join(outRoot, 'reliability-trend.md');
const trendExit = await spawnAndWait(
  'node',
  [
    'scripts/reliability-trend.mjs',
    '--history', './agent-results/local-history.jsonl',
    '--append-scorecard', scorecardPath,
    '--profile', profile,
    '--root', outRoot,
    '--out', trendPath,
    '--md', trendMdPath,
  ],
  { cwd: rootDir, env: benchmarkSyncChildEnv(process.env), stdio: 'inherit' },
);
if (trendExit !== 0) {
  process.exit(trendExit);
}

console.log('\nLocal reliability run complete');
console.log(`- profile: ${profile}`);
console.log(`- output: ${outRoot}`);
console.log(`- scorecard: ${scorecardPath}`);
console.log(`- trend: ${trendPath}`);

await syncBenchmarkOutput({
  rootDir,
  outPath: outRoot,
  label: `local reliability · ${profile}`,
});

function buildSteps() {
  if (profile === 'smoke') {
    return [
      {
        name: 'Local smoke gate',
        command: 'node',
        args: [
          'scripts/run-tier1-gate.mjs',
          '--cases', './bench/scenarios/cases/local-smoke.json',
          '--model', model,
          '--out', path.join(outRoot, 'smoke'),
          '--concurrency', concurrency,
          '--min-full-pass-rate', '1',
          '--min-fast-pass-rate', '1',
          '--max-avg-turns', '24',
          '--max-avg-duration-ms', '120000',
        ],
      },
    ];
  }

  if (profile === 'tier1') {
    return [
      {
        name: 'Tier1 deterministic gate',
        command: 'node',
        args: [
          'scripts/run-tier1-gate.mjs',
          '--model', model,
          '--out', path.join(outRoot, 'tier1'),
          '--min-full-pass-rate', '1',
          '--min-fast-pass-rate', '1',
          '--max-avg-turns', '24',
          '--max-avg-duration-ms', '120000',
        ],
      },
    ];
  }

  if (profile === 'tier2') {
    ensureStorageState();
    return [
      {
        name: 'Tier2 staging gate',
        command: 'node',
        args: [
          'scripts/run-tier2-gate.mjs',
          '--model', model,
          '--out', path.join(outRoot, 'tier2'),
          '--storage-state', path.resolve(storageState),
          '--min-full-pass-rate', '1',
          '--min-fast-pass-rate', '1',
          '--max-avg-turns', '45',
          '--max-avg-duration-ms', '300000',
        ],
      },
    ];
  }

  if (profile === 'nightly') {
    const nightly = [
      { name: 'Typecheck', command: 'pnpm', args: ['lint'] },
      { name: 'Boundary checks', command: 'pnpm', args: ['check:boundaries'] },
      { name: 'Build', command: 'pnpm', args: ['build'] },
      {
        name: 'Tier1 deterministic gate',
        command: 'node',
        args: [
          'scripts/run-tier1-gate.mjs',
          '--model', model,
          '--out', path.join(outRoot, 'tier1'),
          '--min-full-pass-rate', '1',
          '--min-fast-pass-rate', '1',
          '--max-avg-turns', '24',
          '--max-avg-duration-ms', '120000',
        ],
      },
      {
        name: 'WebBench nightly sample',
        command: 'node',
        args: [
          'scripts/run-scenario-track.mjs',
          '--cases', './bench/scenarios/cases/webbench-read-sanity6-max35.json',
          '--config', './bench/scenarios/configs/supervisor-on.mjs',
          '--model', model,
          '--benchmark-profile', 'webbench',
          '--concurrency', '1',
          '--out', path.join(outRoot, 'webbench'),
        ],
      },
    ];
    if (includeTier2) {
      ensureStorageState();
      nightly.push({
        name: 'Tier2 staging gate',
        command: 'node',
        args: [
          'scripts/run-tier2-gate.mjs',
          '--model', model,
          '--out', path.join(outRoot, 'tier2'),
          '--storage-state', path.resolve(storageState),
          '--min-full-pass-rate', '1',
          '--min-fast-pass-rate', '1',
          '--max-avg-turns', '45',
          '--max-avg-duration-ms', '300000',
        ],
      });
    }
    return nightly;
  }

  throw new Error(`Unknown --profile "${profile}". Expected smoke, tier1, tier2, or nightly.`);
}

function ensureStorageState() {
  if (!storageState) {
    throw new Error('--storage-state or AI_TANGLE_STORAGE_STATE_PATH is required for tier2 runs.');
  }
  readAndValidateStorageState(storageState);
}

function spawnAndWait(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    child.once('error', () => resolve(1));
    child.once('close', (code) => resolve(code ?? 1));
  });
}
