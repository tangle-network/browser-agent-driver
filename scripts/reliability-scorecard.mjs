#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyFailure, classifyFailureReason } from './lib/failure-taxonomy.mjs';

const argv = process.argv.slice(2);
const getArg = (name, fallback = undefined) => {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  if (idx === argv.length - 1) return 'true';
  return argv[idx + 1];
};

const root = path.resolve(getArg('root', './agent-results'));
const outPath = getArg('out') ? path.resolve(getArg('out')) : undefined;
const mdPath = getArg('md') ? path.resolve(getArg('md')) : undefined;

if (!fs.existsSync(root)) {
  console.error(`Root does not exist: ${root}`);
  process.exit(1);
}

const suiteReports = findSuiteReports(root);
const records = [];
for (const suitePath of suiteReports) {
  const report = JSON.parse(fs.readFileSync(suitePath, 'utf-8'));
  const mode = detectModeFromPath(suitePath);
  const scenarioIdFromPath = detectScenarioFromPath(suitePath);
  for (const result of report.results ?? []) {
    const testCase = result.testCase ?? {};
    const rawTestId = String(testCase.id || 'unknown');
    const reason = String(result.agentResult?.reason || result.verdict || '').trim();
    const runtimeLog = loadRuntimeLogForResult(suitePath, rawTestId);
    const classification = classifyFailure({ reason, runtimeLog });
    records.push({
      suitePath,
      mode,
      verified: result.verified === true,
      testId: scenarioIdFromPath || rawTestId,
      rawTestId,
      testName: String(testCase.name || 'unknown'),
      startUrl: String(testCase.startUrl || ''),
      domain: safeHost(testCase.startUrl),
      turnsUsed: Number(result.turnsUsed ?? 0),
      durationMs: Number(result.durationMs ?? 0),
      tokensUsed: Number(result.tokensUsed ?? 0),
      failureClass: classification.failureClass,
      classificationSource: classification.source,
      classificationEvidence: classification.evidence,
      fallbackReasonClass: classification.fallbackReasonClass,
      reason,
      runtimeLogPresent: runtimeLog != null,
      runtimeLogPath: runtimeLog?._path || '',
    });
  }
}

const total = records.length;
const passed = records.filter((r) => r.verified).length;
const failed = total - passed;
const failedRecords = records.filter((r) => !r.verified);

const byClass = countBy(failedRecords, (r) => r.failureClass);
const byTest = countBy(failedRecords, (r) => r.testId);
const byDomain = countBy(failedRecords, (r) => r.domain || 'unknown');
const byModeClass = countBy(failedRecords, (r) => `${r.mode}:${r.failureClass}`);
const byReason = countBy(failedRecords, (r) => normalizeReason(r.reason));

const scorecard = {
  generatedAt: new Date().toISOString(),
  root,
  suiteReports: suiteReports.length,
  totalTests: total,
  passed,
  failed,
  passRate: total > 0 ? passed / total : 0,
  leaderboard: {
    failureClasses: toLeaderboard(byClass),
    scenarios: toLeaderboard(byTest),
    domains: toLeaderboard(byDomain),
    modeByClass: toLeaderboard(byModeClass),
    topReasons: toLeaderboard(byReason),
  },
  diagnostics: {
    avgFailedTurns: mean(failedRecords.map((r) => r.turnsUsed)),
    avgFailedDurationMs: mean(failedRecords.map((r) => r.durationMs)),
    avgFailedTokens: mean(failedRecords.map((r) => r.tokensUsed)),
    runtimeLogCoverage: total > 0 ? records.filter((r) => r.runtimeLogPresent).length / total : 0,
    runtimeDrivenClassificationRate: failed > 0 ? failedRecords.filter((r) => r.classificationSource === 'runtime-log').length / failed : 0,
  },
  runtimeSignals: {
    present: records.filter((r) => r.runtimeLogPresent).length,
    missing: records.filter((r) => !r.runtimeLogPresent).length,
    classifiedFromRuntime: failedRecords.filter((r) => r.classificationSource === 'runtime-log').length,
  },
  topFailures: failedRecords.slice(0, 50).map((r) => ({
    class: r.failureClass,
    mode: r.mode,
    testId: r.testId,
    testName: r.testName,
    domain: r.domain,
    turnsUsed: r.turnsUsed,
    durationMs: r.durationMs,
    reason: r.reason.slice(0, 300),
    classificationSource: r.classificationSource,
    evidence: r.classificationEvidence,
    runtimeLogPath: r.runtimeLogPath,
    suitePath: r.suitePath,
  })),
};

const outputJson = `${JSON.stringify(scorecard, null, 2)}\n`;
if (outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, outputJson);
}
if (mdPath) {
  fs.mkdirSync(path.dirname(mdPath), { recursive: true });
  fs.writeFileSync(mdPath, renderMarkdown(scorecard));
}

console.log(outputJson);

function findSuiteReports(startRoot) {
  const reports = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === 'report.json' && full.includes(`${path.sep}suite${path.sep}`)) {
        reports.push(full);
      }
    }
  };
  walk(startRoot);
  return reports;
}

function loadRuntimeLogForResult(suitePath, testId) {
  const suiteDir = path.dirname(suitePath);
  const modeDir = path.dirname(suiteDir);
  const directPath = path.join(modeDir, testId, 'runtime-log.json');
  if (fs.existsSync(directPath)) {
    return readRuntimeLog(directPath);
  }

  const manifestPath = path.join(modeDir, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      if (Array.isArray(manifest)) {
        const runtimeEntry = manifest.find((entry) => entry?.testId === testId && entry?.type === 'runtime-log');
        if (runtimeEntry?.uri) {
          const runtimePath = fileUriToPath(runtimeEntry.uri);
          if (runtimePath && fs.existsSync(runtimePath)) {
            return readRuntimeLog(runtimePath);
          }
        }
      }
    } catch {
      // Best effort only.
    }
  }

  return null;
}

function detectModeFromPath(reportPath) {
  if (reportPath.includes(`${path.sep}full-evidence${path.sep}`)) return 'full-evidence';
  if (reportPath.includes(`${path.sep}fast-explore${path.sep}`)) return 'fast-explore';
  return 'unknown';
}

function detectScenarioFromPath(reportPath) {
  const parts = reportPath.split(path.sep).filter(Boolean);
  const suiteIdx = parts.lastIndexOf('suite');
  if (suiteIdx >= 2) {
    return parts[suiteIdx - 2] || '';
  }
  return '';
}

function safeHost(input) {
  if (!input || typeof input !== 'string') return '';
  try {
    return new URL(input).host;
  } catch {
    return '';
  }
}

function normalizeReason(reasonRaw) {
  const reason = String(reasonRaw || '').replace(/\s+/g, ' ').trim();
  if (!reason) return 'unknown';
  if (reason.length <= 140) return reason;
  return `${reason.slice(0, 140)}...`;
}

function readRuntimeLog(runtimePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(runtimePath, 'utf-8'));
    return { ...parsed, _path: runtimePath };
  } catch {
    return null;
  }
}

function fileUriToPath(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return '';
  try {
    return fileURLToPath(uri);
  } catch {
    return '';
  }
}

function countBy(rows, keyFn) {
  const counts = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function toLeaderboard(map) {
  const total = Array.from(map.values()).reduce((acc, value) => acc + value, 0);
  return Array.from(map.entries())
    .map(([name, count]) => ({
      name,
      count,
      share: total > 0 ? count / total : 0,
    }))
    .sort((a, b) => b.count - a.count);
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((acc, value) => acc + Number(value || 0), 0) / values.length;
}

function renderMarkdown(scorecard) {
  const lines = [];
  lines.push('# Reliability Scorecard');
  lines.push('');
  lines.push(`- Root: \`${scorecard.root}\``);
  lines.push(`- Pass rate: ${(scorecard.passRate * 100).toFixed(1)}% (${scorecard.passed}/${scorecard.totalTests})`);
  lines.push(`- Failed tests: ${scorecard.failed}`);
  lines.push(`- Runtime log coverage: ${(scorecard.diagnostics.runtimeLogCoverage * 100).toFixed(1)}%`);
  lines.push(`- Runtime-driven classification: ${(scorecard.diagnostics.runtimeDrivenClassificationRate * 100).toFixed(1)}% of failures`);
  lines.push('');
  lines.push('## Failure Class Leaderboard');
  lines.push('');
  for (const item of scorecard.leaderboard.failureClasses.slice(0, 10)) {
    lines.push(`- ${item.name}: ${item.count} (${(item.share * 100).toFixed(1)}%)`);
  }
  lines.push('');
  lines.push('## Scenario Leaderboard');
  lines.push('');
  for (const item of scorecard.leaderboard.scenarios.slice(0, 10)) {
    lines.push(`- ${item.name}: ${item.count}`);
  }
  lines.push('');
  lines.push('## Domain Leaderboard');
  lines.push('');
  for (const item of scorecard.leaderboard.domains.slice(0, 10)) {
    lines.push(`- ${item.name}: ${item.count}`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}
