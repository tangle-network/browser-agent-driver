#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
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
const casesPath = path.resolve(getArg('cases', './bench/scenarios/cases/local-deterministic.json'));
const configPath = path.resolve(getArg('config', './bench/scenarios/configs/supervisor-on.mjs'));
const model = getArg('model', 'gpt-5.2');
const outRoot = path.resolve(getArg('out', `./agent-results/tier1-gate-${Date.now()}`));
const concurrency = clampInt(getArg('concurrency', '1'), 1, 32);
const minFullPassRate = Number.parseFloat(getArg('min-full-pass-rate', '1'));
const minFastPassRate = Number.parseFloat(getArg('min-fast-pass-rate', '1'));
const maxAvgTurns = Number.parseFloat(getArg('max-avg-turns', 'Infinity'));
const maxAvgDurationMs = Number.parseFloat(getArg('max-avg-duration-ms', 'Infinity'));

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

fs.mkdirSync(outRoot, { recursive: true });

const fixturesDir = path.join(rootDir, 'bench', 'fixtures');
const server = await startStaticServer(fixturesDir);

let exitCode = 1;
try {
  exitCode = await spawnAndWait(
    'node',
    [
      'scripts/run-scenario-track.mjs',
      '--cases', casesPath,
      '--config', configPath,
      '--model', model,
      '--out', outRoot,
      '--concurrency', String(concurrency),
      '--fixture-base-url', server.baseUrl,
  ],
    { cwd: rootDir, env: benchmarkSyncChildEnv(process.env), stdio: 'inherit' },
  );
} finally {
  await server.close();
}

if (exitCode !== 0) {
  console.error(`Track execution failed with exit code ${exitCode}`);
  process.exit(exitCode);
}

const trackSummaryPath = path.join(outRoot, 'track-summary.json');
if (!fs.existsSync(trackSummaryPath)) {
  console.error(`Missing track summary: ${trackSummaryPath}`);
  process.exit(1);
}

const trackSummary = JSON.parse(fs.readFileSync(trackSummaryPath, 'utf-8'));
const scenarioRows = [];
const artifactChecks = [];
for (const result of trackSummary.results ?? []) {
  const runs = result.summary?.runs ?? [];
  const full = runs.find((run) => run.mode === 'full-evidence')?.metrics ?? {};
  const fast = runs.find((run) => run.mode === 'fast-explore')?.metrics ?? {};
  const artifacts = verifyScenarioArtifacts({
    scenarioId: result.scenarioId,
    summaryPath: result.summaryPath,
    runs,
  });
  artifactChecks.push(...artifacts);
  scenarioRows.push({
    scenarioId: result.scenarioId,
    scenarioName: result.scenarioName,
    full,
    fast,
    artifacts,
    exitCode: result.exitCode,
  });
}

const aggregate = summarize(scenarioRows);
const artifactFailures = artifactChecks
  .filter((row) => !row.passed)
  .map((row) => `${row.scenarioId} (${row.mode}) artifact check failed: ${row.failures.join('; ')}`);
const metricGateFailures = evaluateGate({
  aggregate,
  minFullPassRate,
  minFastPassRate,
  maxAvgTurns,
  maxAvgDurationMs,
});
const gateFailures = [...metricGateFailures, ...artifactFailures];

const gateSummary = {
  generatedAt: new Date().toISOString(),
  mode: 'tier1-deterministic-gate',
  model,
  configPath,
  casesPath,
  outRoot,
  fixtureBaseUrl: server.baseUrl,
  thresholds: {
    minFullPassRate,
    minFastPassRate,
    maxAvgTurns,
    maxAvgDurationMs,
  },
  aggregate,
  scenarios: scenarioRows,
  artifactChecks: {
    total: artifactChecks.length,
    passed: artifactChecks.filter((row) => row.passed).length,
    failed: artifactChecks.filter((row) => !row.passed).length,
    rows: artifactChecks,
  },
  gateFailures,
  passed: gateFailures.length === 0,
};

const gateSummaryPath = path.join(outRoot, 'tier1-gate-summary.json');
fs.writeFileSync(gateSummaryPath, `${JSON.stringify(gateSummary, null, 2)}\n`);
const gateMdPath = path.join(outRoot, 'tier1-gate-summary.md');
fs.writeFileSync(gateMdPath, renderMarkdown(gateSummary));

console.log(`\nTier1 gate summary: ${gateSummaryPath}`);
console.log(`Tier1 gate markdown: ${gateMdPath}`);

await syncBenchmarkOutput({
  rootDir,
  outPath: outRoot,
  label: `${path.basename(casesPath)} · tier1 gate`,
});

if (gateFailures.length > 0) {
  for (const failure of gateFailures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('Tier1 deterministic gate PASSED');

function summarize(rows) {
  const fullRows = rows.map((row) => row.full).filter(Boolean);
  const fastRows = rows.map((row) => row.fast).filter(Boolean);
  return {
    scenarios: rows.length,
    fullEvidence: {
      passRate: mean(fullRows.map((m) => toBinaryPass(m))),
      avgTurns: mean(fullRows.map((m) => Number(m.turnsUsed ?? 0))),
      avgDurationMs: mean(fullRows.map((m) => Number(m.durationMs ?? 0))),
      avgTokens: mean(fullRows.map((m) => Number(m.tokensUsed ?? 0))),
    },
    fastExplore: {
      passRate: mean(fastRows.map((m) => toBinaryPass(m))),
      avgTurns: mean(fastRows.map((m) => Number(m.turnsUsed ?? 0))),
      avgDurationMs: mean(fastRows.map((m) => Number(m.durationMs ?? 0))),
      avgTokens: mean(fastRows.map((m) => Number(m.tokensUsed ?? 0))),
    },
  };
}

function evaluateGate(input) {
  const failures = [];
  if (input.aggregate.fullEvidence.passRate < input.minFullPassRate) {
    failures.push(
      `full-evidence pass rate ${pct(input.aggregate.fullEvidence.passRate)} below threshold ${pct(input.minFullPassRate)}`,
    );
  }
  if (input.aggregate.fastExplore.passRate < input.minFastPassRate) {
    failures.push(
      `fast-explore pass rate ${pct(input.aggregate.fastExplore.passRate)} below threshold ${pct(input.minFastPassRate)}`,
    );
  }
  if (input.aggregate.fullEvidence.avgTurns > input.maxAvgTurns) {
    failures.push(
      `full-evidence avg turns ${input.aggregate.fullEvidence.avgTurns.toFixed(2)} exceeds ${input.maxAvgTurns}`,
    );
  }
  if (input.aggregate.fastExplore.avgTurns > input.maxAvgTurns) {
    failures.push(
      `fast-explore avg turns ${input.aggregate.fastExplore.avgTurns.toFixed(2)} exceeds ${input.maxAvgTurns}`,
    );
  }
  if (input.aggregate.fullEvidence.avgDurationMs > input.maxAvgDurationMs) {
    failures.push(
      `full-evidence avg duration ${Math.round(input.aggregate.fullEvidence.avgDurationMs)}ms exceeds ${Math.round(input.maxAvgDurationMs)}ms`,
    );
  }
  if (input.aggregate.fastExplore.avgDurationMs > input.maxAvgDurationMs) {
    failures.push(
      `fast-explore avg duration ${Math.round(input.aggregate.fastExplore.avgDurationMs)}ms exceeds ${Math.round(input.maxAvgDurationMs)}ms`,
    );
  }
  return failures;
}

function renderMarkdown(summary) {
  const lines = [];
  lines.push('# Tier1 Deterministic Gate');
  lines.push('');
  lines.push(`- Passed: **${summary.passed ? 'yes' : 'no'}**`);
  lines.push(`- Generated: ${summary.generatedAt}`);
  lines.push(`- Cases: \`${summary.casesPath}\``);
  lines.push(`- Model: \`${summary.model}\``);
  lines.push('');
  lines.push('## Aggregate');
  lines.push('');
  lines.push(`- full-evidence pass rate: ${pct(summary.aggregate.fullEvidence.passRate)}`);
  lines.push(`- fast-explore pass rate: ${pct(summary.aggregate.fastExplore.passRate)}`);
  lines.push(`- full-evidence avg turns: ${summary.aggregate.fullEvidence.avgTurns.toFixed(2)}`);
  lines.push(`- fast-explore avg turns: ${summary.aggregate.fastExplore.avgTurns.toFixed(2)}`);
  lines.push(`- full-evidence avg duration: ${Math.round(summary.aggregate.fullEvidence.avgDurationMs)}ms`);
  lines.push(`- fast-explore avg duration: ${Math.round(summary.aggregate.fastExplore.avgDurationMs)}ms`);
  lines.push('');
  lines.push('## Artifact Completeness');
  lines.push('');
  lines.push(`- checks: ${summary.artifactChecks.total}`);
  lines.push(`- passed: ${summary.artifactChecks.passed}`);
  lines.push(`- failed: ${summary.artifactChecks.failed}`);
  lines.push('');
  if (summary.gateFailures.length > 0) {
    lines.push('## Gate Failures');
    lines.push('');
    for (const failure of summary.gateFailures) lines.push(`- ${failure}`);
  }
  lines.push('');
  lines.push('## Scenarios');
  lines.push('');
  for (const row of summary.scenarios) {
    const artifactStatus = row.artifacts.every((check) => check.passed) ? 'pass' : 'fail';
    lines.push(`- ${row.scenarioId}: full=${row.full?.passed ? 'pass' : 'fail'}, fast=${row.fast?.passed ? 'pass' : 'fail'}, artifacts=${artifactStatus}`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function toBinaryPass(metrics) {
  return metrics?.passed ? 1 : 0;
}

function pct(value) {
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((acc, value) => acc + Number(value || 0), 0) / values.length;
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

function verifyScenarioArtifacts({ scenarioId, summaryPath, runs }) {
  const scenarioDir = summaryPath ? path.dirname(path.resolve(summaryPath)) : null;
  const checks = [];
  if (!Array.isArray(runs) || runs.length === 0) {
    checks.push({
      scenarioId,
      mode: 'all',
      passed: false,
      failures: ['missing mode run outputs'],
      files: {},
      recording: { exists: false, source: 'none', path: '' },
    });
    return checks;
  }
  for (const run of runs ?? []) {
    const mode = String(run.mode || 'unknown');
    const defaultModeDir = scenarioDir ? path.join(scenarioDir, mode) : null;
    const reportPath = run.reportPath
      ? path.resolve(run.reportPath)
      : defaultModeDir
        ? path.join(defaultModeDir, 'report.json')
        : '';
    const modeDir = reportPath ? path.dirname(reportPath) : (defaultModeDir ?? '');

    const requiredFiles = [
      { key: 'report', path: reportPath },
      { key: 'manifest', path: path.join(modeDir, 'manifest.json') },
      { key: 'suiteReport', path: path.join(modeDir, 'suite', 'report.json') },
      { key: 'suiteManifest', path: path.join(modeDir, 'suite', 'manifest.json') },
    ];

    const fileChecks = {};
    const failures = [];
    for (const required of requiredFiles) {
      const exists = required.path ? fs.existsSync(required.path) : false;
      const sizeBytes = exists ? fs.statSync(required.path).size : 0;
      fileChecks[required.key] = { exists, sizeBytes, path: required.path };
      if (!exists || sizeBytes === 0) {
        failures.push(`missing/non-empty ${required.key}`);
      }
    }

    const videoStatus = detectVideoArtifact(modeDir, [
      path.join(modeDir, 'manifest.json'),
      path.join(modeDir, 'suite', 'manifest.json'),
    ]);
    if (!videoStatus.exists) {
      failures.push('missing recording artifact');
    }

    checks.push({
      scenarioId,
      mode,
      passed: failures.length === 0,
      failures,
      files: fileChecks,
      recording: videoStatus,
    });
  }
  return checks;
}

function detectVideoArtifact(modeDir, manifestPaths) {
  for (const manifestPath of manifestPaths) {
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      if (!Array.isArray(manifest)) continue;
      const hit = manifest.find((entry) => entry?.type === 'video' && Number(entry?.sizeBytes || 0) > 0);
      if (hit) {
        return {
          exists: true,
          source: 'manifest',
          path: manifestPath,
        };
      }
    } catch {
      // Best effort parsing.
    }
  }

  const fallbackPaths = [
    path.join(modeDir, 'cli-task', 'recording.webm'),
  ];
  for (const fallbackPath of fallbackPaths) {
    if (!fs.existsSync(fallbackPath)) continue;
    if (fs.statSync(fallbackPath).size > 0) {
      return {
        exists: true,
        source: 'file',
        path: fallbackPath,
      };
    }
  }

  const videosDir = path.join(modeDir, '_videos');
  if (fs.existsSync(videosDir)) {
    const hasVideo = fs.readdirSync(videosDir)
      .filter((name) => name.endsWith('.webm'))
      .some((name) => fs.statSync(path.join(videosDir, name)).size > 0);
    if (hasVideo) {
      return {
        exists: true,
        source: 'videos-dir',
        path: videosDir,
      };
    }
  }

  return {
    exists: false,
    source: 'none',
    path: '',
  };
}

async function startStaticServer(root) {
  const server = http.createServer((req, res) => {
    const rawPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const safePath = rawPath === '/' ? '/index.html' : rawPath;
    const normalized = path.normalize(safePath).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(root, normalized);
    if (!filePath.startsWith(root)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = ext === '.html'
      ? 'text/html; charset=utf-8'
      : ext === '.js'
        ? 'text/javascript; charset=utf-8'
        : ext === '.css'
          ? 'text/css; charset=utf-8'
          : 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.end(fs.readFileSync(filePath));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
