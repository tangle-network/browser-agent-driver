#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const getArg = (name, fallback = undefined) => {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  if (idx === argv.length - 1) return 'true';
  return argv[idx + 1];
};

const roots = collectRoots();
const outPath = getArg('out') ? path.resolve(getArg('out')) : undefined;
const mdPath = getArg('md') ? path.resolve(getArg('md')) : undefined;

if (roots.length === 0) {
  console.error('Provide one or more --root <path> arguments.');
  process.exit(1);
}

const rows = [];
for (const root of roots) {
  const resolvedRoot = path.resolve(root);
  const trackSummaryPath = path.join(resolvedRoot, 'track-summary.json');
  const tier3SummaryPath = path.join(resolvedRoot, 'tier3-gate-summary.json');
  const summaryPath = fs.existsSync(trackSummaryPath)
    ? trackSummaryPath
    : fs.existsSync(tier3SummaryPath)
      ? tier3SummaryPath
      : null;

  if (!summaryPath) {
    rows.push({
      root: resolvedRoot,
      kind: 'missing',
      error: 'No track-summary.json or tier3-gate-summary.json found',
    });
    continue;
  }

  const parsed = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const scenarioRows = summaryPath.endsWith('track-summary.json')
    ? fromTrackSummary(resolvedRoot, parsed)
    : fromTier3Summary(resolvedRoot, parsed);
  rows.push(...scenarioRows);
}

const grouped = groupBy(rows.filter((row) => row.kind === 'scenario'), (row) => row.root);
const scoreboard = {
  generatedAt: new Date().toISOString(),
  roots: roots.map((root) => path.resolve(root)),
  summaries: Array.from(grouped.entries()).map(([root, scenarios]) => ({
    root,
    scenarios,
    aggregate: {
      passRate: safeDiv(scenarios.filter((row) => row.pass).length, scenarios.length),
      medianDurationMs: median(scenarios.map((row) => row.durationMs)),
      medianTurns: median(scenarios.map((row) => row.turns)),
      medianTokens: median(scenarios.map((row) => row.tokens)),
    },
  })),
  errors: rows.filter((row) => row.kind === 'missing'),
};

const json = `${JSON.stringify(scoreboard, null, 2)}\n`;
if (outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, json);
}
if (mdPath) {
  fs.mkdirSync(path.dirname(mdPath), { recursive: true });
  fs.writeFileSync(mdPath, renderMarkdown(scoreboard));
}

console.log(json);

function collectRoots() {
  const values = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root' && argv[i + 1]) values.push(argv[i + 1]);
  }
  return values;
}

function fromTrackSummary(root, parsed) {
  return (parsed.results ?? []).map((result) => {
    const run = result.summary?.runs?.[0];
    const metrics = run?.metrics ?? {};
    return {
      kind: 'scenario',
      root,
      scenarioId: result.scenarioId,
      scenarioName: result.scenarioName,
      pass: Boolean(metrics.passed),
      durationMs: Number(metrics.durationMs ?? 0),
      turns: Number(metrics.turnsUsed ?? 0),
      tokens: Number(metrics.tokensUsed ?? 0),
      reportPath: run?.reportPath ?? null,
      summaryPath: result.summaryPath ?? null,
    };
  });
}

function fromTier3Summary(root, parsed) {
  return (parsed.cases ?? []).map((scenario) => ({
    kind: 'scenario',
    root,
    scenarioId: scenario.scenarioId,
    scenarioName: scenario.scenarioName,
    pass: Number(scenario.passRate ?? 0) >= 1,
    durationMs: Number(scenario.medianDurationMs ?? 0),
    turns: Number(scenario.medianTurns ?? 0),
    tokens: Number(scenario.medianTokens ?? 0),
    reportPath: null,
    summaryPath: path.join(root, 'tier3-gate-summary.json'),
  }));
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    const current = map.get(key) ?? [];
    current.push(row);
    map.set(key, current);
  }
  return map;
}

function safeDiv(a, b) {
  return b === 0 ? 0 : a / b;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function renderMarkdown(scoreboard) {
  const lines = [];
  lines.push('# Benchmark Scoreboard');
  lines.push('');
  lines.push(`- Generated: ${scoreboard.generatedAt}`);
  lines.push('');

  for (const summary of scoreboard.summaries) {
    lines.push(`## ${summary.root}`);
    lines.push('');
    lines.push(`- Pass rate: ${(summary.aggregate.passRate * 100).toFixed(1)}%`);
    lines.push(`- Median duration: ${(summary.aggregate.medianDurationMs / 1000).toFixed(1)}s`);
    lines.push(`- Median turns: ${summary.aggregate.medianTurns}`);
    lines.push(`- Median tokens: ${fmtInt(summary.aggregate.medianTokens)}`);
    lines.push('');
    lines.push('| Scenario | Pass | Duration | Turns | Tokens |');
    lines.push('| --- | --- | ---: | ---: | ---: |');
    for (const row of summary.scenarios) {
      lines.push(`| ${row.scenarioId} | ${row.pass ? 'yes' : 'no'} | ${(row.durationMs / 1000).toFixed(1)}s | ${row.turns} | ${fmtInt(row.tokens)} |`);
    }
    lines.push('');
  }

  if (scoreboard.errors.length > 0) {
    lines.push('## Errors');
    lines.push('');
    for (const error of scoreboard.errors) {
      lines.push(`- ${error.root}: ${error.error}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function fmtInt(value) {
  return new Intl.NumberFormat('en-US').format(Math.round(value));
}
