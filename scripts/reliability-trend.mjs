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

const historyPath = path.resolve(getArg('history', './agent-results/local-history.jsonl'));
const appendScorecard = getArg('append-scorecard');
const profile = getArg('profile', '');
const root = getArg('root', '');
const outPath = getArg('out') ? path.resolve(getArg('out')) : undefined;
const mdPath = getArg('md') ? path.resolve(getArg('md')) : undefined;

if (appendScorecard) {
  const entry = buildEntry({
    scorecardPath: path.resolve(appendScorecard),
    profile,
    root,
  });
  appendHistory(historyPath, entry);
}

const history = readHistory(historyPath);
const filtered = profile ? history.filter((entry) => entry.profile === profile) : history;
const latest = filtered.at(-1) ?? null;
const previous = filtered.length >= 2 ? filtered.at(-2) : null;

const trend = {
  generatedAt: new Date().toISOString(),
  historyPath,
  totalEntries: history.length,
  filteredEntries: filtered.length,
  profile: profile || null,
  latest,
  previous,
  delta: latest && previous ? computeDelta(latest, previous) : null,
  recent: filtered.slice(-10).reverse(),
};

const output = `${JSON.stringify(trend, null, 2)}\n`;
if (outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, output);
}
if (mdPath) {
  fs.mkdirSync(path.dirname(mdPath), { recursive: true });
  fs.writeFileSync(mdPath, renderMarkdown(trend));
}

console.log(output);

function buildEntry({ scorecardPath, profile, root }) {
  if (!fs.existsSync(scorecardPath)) {
    throw new Error(`Scorecard not found: ${scorecardPath}`);
  }
  const scorecard = JSON.parse(fs.readFileSync(scorecardPath, 'utf-8'));
  const topFailureClass = Array.isArray(scorecard?.leaderboard?.failureClasses) && scorecard.leaderboard.failureClasses.length > 0
    ? String(scorecard.leaderboard.failureClasses[0].name || 'unknown')
    : 'none';

  return {
    generatedAt: String(scorecard.generatedAt || new Date().toISOString()),
    profile: profile || 'unknown',
    root: root || String(scorecard.root || ''),
    scorecardPath,
    totalTests: Number(scorecard.totalTests || 0),
    passed: Number(scorecard.passed || 0),
    failed: Number(scorecard.failed || 0),
    passRate: Number(scorecard.passRate || 0),
    runtimeLogCoverage: Number(scorecard?.diagnostics?.runtimeLogCoverage || 0),
    runtimeDrivenClassificationRate: Number(scorecard?.diagnostics?.runtimeDrivenClassificationRate || 0),
    topFailureClass,
  };
}

function appendHistory(targetPath, entry) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.appendFileSync(targetPath, `${JSON.stringify(entry)}\n`);
}

function readHistory(targetPath) {
  if (!fs.existsSync(targetPath)) return [];
  return fs.readFileSync(targetPath, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(a.generatedAt || '').localeCompare(String(b.generatedAt || '')));
}

function computeDelta(latest, previous) {
  return {
    passRate: Number(latest.passRate || 0) - Number(previous.passRate || 0),
    failed: Number(latest.failed || 0) - Number(previous.failed || 0),
    runtimeLogCoverage: Number(latest.runtimeLogCoverage || 0) - Number(previous.runtimeLogCoverage || 0),
    runtimeDrivenClassificationRate: Number(latest.runtimeDrivenClassificationRate || 0) - Number(previous.runtimeDrivenClassificationRate || 0),
    topFailureClassChanged: String(latest.topFailureClass || '') !== String(previous.topFailureClass || ''),
  };
}

function renderMarkdown(trend) {
  const lines = [];
  lines.push('# Reliability Trend');
  lines.push('');
  lines.push(`- History: \`${trend.historyPath}\``);
  lines.push(`- Entries: ${trend.filteredEntries}/${trend.totalEntries}`);
  if (trend.profile) lines.push(`- Profile: \`${trend.profile}\``);
  lines.push('');

  if (trend.latest) {
    lines.push('## Latest');
    lines.push('');
    lines.push(`- Generated: ${trend.latest.generatedAt}`);
    lines.push(`- Pass rate: ${(trend.latest.passRate * 100).toFixed(1)}% (${trend.latest.passed}/${trend.latest.totalTests})`);
    lines.push(`- Failed: ${trend.latest.failed}`);
    lines.push(`- Runtime log coverage: ${(trend.latest.runtimeLogCoverage * 100).toFixed(1)}%`);
    lines.push(`- Runtime-driven classification: ${(trend.latest.runtimeDrivenClassificationRate * 100).toFixed(1)}%`);
    lines.push(`- Top failure class: ${trend.latest.topFailureClass}`);
    lines.push('');
  }

  if (trend.delta) {
    lines.push('## Delta vs Previous');
    lines.push('');
    lines.push(`- Pass rate: ${formatDeltaPct(trend.delta.passRate)}`);
    lines.push(`- Failed tests: ${formatDeltaInt(trend.delta.failed)}`);
    lines.push(`- Runtime log coverage: ${formatDeltaPct(trend.delta.runtimeLogCoverage)}`);
    lines.push(`- Runtime-driven classification: ${formatDeltaPct(trend.delta.runtimeDrivenClassificationRate)}`);
    lines.push(`- Top failure class changed: ${trend.delta.topFailureClassChanged ? 'yes' : 'no'}`);
    lines.push('');
  }

  if (trend.recent.length > 0) {
    lines.push('## Recent Runs');
    lines.push('');
    for (const entry of trend.recent.slice(0, 10)) {
      lines.push(`- ${entry.generatedAt} | ${entry.profile} | ${(Number(entry.passRate || 0) * 100).toFixed(1)}% | failed=${entry.failed} | top=${entry.topFailureClass}`);
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function formatDeltaPct(value) {
  const num = Number(value || 0) * 100;
  return `${num >= 0 ? '+' : ''}${num.toFixed(1)}pp`;
}

function formatDeltaInt(value) {
  const num = Number(value || 0);
  return `${num >= 0 ? '+' : ''}${num}`;
}
