/**
 * Test Report Generation — markdown, JSON, HTML output + comparison.
 */

import type { TestSuiteResult } from './types.js';
import { generateJUnitXml } from './reporters/junit.js';

export interface ReportOptions {
  format: 'json' | 'markdown' | 'html' | 'junit';
  /** Include last N turns per test in report */
  includeTurns?: boolean;
  /** Include screenshots in report */
  includeScreenshots?: boolean;
}

export function generateReport(suite: TestSuiteResult, options: ReportOptions): string {
  switch (options.format) {
    case 'json':
      return JSON.stringify(suite, null, 2);
    case 'markdown':
      return generateMarkdownReport(suite, options);
    case 'html':
      return generateHtmlReport(suite);
    case 'junit':
      return generateJUnitXml(suite);
    default:
      throw new Error(`Unknown format: ${options.format}`);
  }
}

function generateMarkdownReport(suite: TestSuiteResult, options: ReportOptions): string {
  const lines: string[] = [];
  const { summary, results } = suite;

  lines.push('# Test Suite Report\n');
  lines.push(`**Model:** ${suite.model}`);
  lines.push(`**Date:** ${suite.timestamp}`);
  lines.push(`**Pass Rate:** ${(summary.passRate * 100).toFixed(1)}% (${summary.passed}/${summary.total})`);
  lines.push(`**Duration:** ${(summary.totalDurationMs / 1000).toFixed(1)}s\n`);

  // Summary metrics
  lines.push('## Summary\n');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Total | ${summary.total} |`);
  lines.push(`| Passed | ${summary.passed} |`);
  lines.push(`| Failed | ${summary.failed} |`);
  lines.push(`| Skipped | ${summary.skipped} |`);
  lines.push(`| Avg Turns | ${summary.avgTurns.toFixed(1)} |`);
  lines.push(`| Avg Tokens | ${summary.avgTokens.toFixed(0)} |`);
  lines.push(`| Avg Duration | ${(summary.avgDurationMs / 1000).toFixed(1)}s |`);
  lines.push(`| p50 Duration | ${(summary.p50DurationMs / 1000).toFixed(1)}s |`);
  lines.push(`| p95 Duration | ${(summary.p95DurationMs / 1000).toFixed(1)}s |`);

  // Per-test results
  lines.push('\n## Results\n');
  lines.push('| Test | Category | Agent | Verified | Turns | Tokens | Duration |');
  lines.push('|------|----------|-------|----------|-------|--------|----------|');

  for (const r of results) {
    const agent = r.skipped ? 'SKIP' : r.agentSuccess ? 'Y' : 'N';
    const verified = r.skipped ? 'SKIP' : r.verified ? 'PASS' : 'FAIL';
    const duration = r.skipped ? '-' : `${(r.durationMs / 1000).toFixed(1)}s`;
    const category = esc(r.testCase.category || '-');
    lines.push(
      `| ${esc(r.testCase.name)} | ${category} | ${agent} | ${verified} | ${r.turnsUsed} | ${r.tokensUsed} | ${duration} |`,
    );
  }

  // Failure details
  const failures = results.filter((r) => !r.skipped && !r.verified);
  if (failures.length > 0) {
    lines.push('\n## Failures\n');
    for (const r of failures) {
      lines.push(`### ${esc(r.testCase.name)} (${r.testCase.id})\n`);
      lines.push(`- **Goal:** ${esc(r.testCase.goal.slice(0, 150))}`);
      lines.push(`- **Agent reported:** ${r.agentSuccess ? 'success' : 'failure'}`);
      lines.push(`- **Verdict:** ${esc(r.verdict)}`);
      lines.push(`- **Turns:** ${r.turnsUsed}/${r.testCase.maxTurns ?? 30}`);

      if (r.criteriaResults?.length) {
        lines.push('- **Criteria:**');
        for (const c of r.criteriaResults) {
          const icon = c.passed ? 'PASS' : 'FAIL';
          const desc = c.criterion.description || c.criterion.type;
          lines.push(`  - [${icon}] ${esc(desc)}${c.detail ? ': ' + esc(c.detail) : ''}`);
        }
      }

      // Last actions for debugging
      const lastTurns = r.agentResult.turns.slice(-5);
      if (lastTurns.length > 0) {
        lines.push('- **Last actions:**');
        for (const t of lastTurns) {
          const actionStr = JSON.stringify(t.action).slice(0, 100);
          const verified = t.verified === false ? ' [UNVERIFIED]' : '';
          lines.push(`  - Turn ${t.turn}: ${esc(actionStr)}${verified}`);
        }
      }
      lines.push('');
    }
  }

  // Optional turn logs
  if (options.includeTurns) {
    const nonSkipped = results.filter((r) => !r.skipped && r.agentResult.turns.length > 0);
    if (nonSkipped.length > 0) {
      lines.push('\n## Turn Logs\n');
      for (const r of nonSkipped) {
        lines.push(`### ${r.verified ? 'PASS' : 'FAIL'} ${esc(r.testCase.name)}\n`);
        lines.push('<details><summary>Turn Log</summary>\n');
        for (const turn of r.agentResult.turns.slice(-10)) {
          lines.push(`- Turn ${turn.turn}: \`${esc(JSON.stringify(turn.action))}\``);
          if (turn.reasoning) {
            lines.push(`  - Reasoning: ${esc(turn.reasoning.slice(0, 100))}`);
          }
        }
        lines.push('\n</details>\n');
      }
    }
  }

  return lines.join('\n');
}

function generateHtmlReport(suite: TestSuiteResult): string {
  const { summary } = suite;
  return `<!DOCTYPE html>
<html>
<head>
  <title>Test Suite Report</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; }
    .passed { color: #22c55e; }
    .failed { color: #ef4444; }
    .skipped { color: #9ca3af; }
    .summary { display: flex; gap: 20px; margin: 20px 0; }
    .summary-card { padding: 20px; border-radius: 8px; background: #f3f4f6; min-width: 100px; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #e5e7eb; }
    th { background: #f9fafb; font-weight: 600; }
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 16px 0; }
    .metric { padding: 12px; background: #f9fafb; border-radius: 6px; }
    .metric-value { font-size: 1.5em; font-weight: 700; }
    .metric-label { font-size: 0.85em; color: #6b7280; }
  </style>
</head>
<body>
  <h1>Test Suite Report</h1>
  <p><strong>Model:</strong> ${suite.model} | <strong>Date:</strong> ${suite.timestamp} | <strong>Duration:</strong> ${(summary.totalDurationMs / 1000).toFixed(1)}s</p>

  <div class="summary">
    <div class="summary-card"><div class="metric-value passed">${summary.passed}</div><div class="metric-label">Passed</div></div>
    <div class="summary-card"><div class="metric-value failed">${summary.failed}</div><div class="metric-label">Failed</div></div>
    <div class="summary-card"><div class="metric-value skipped">${summary.skipped}</div><div class="metric-label">Skipped</div></div>
    <div class="summary-card"><div class="metric-value">${(summary.passRate * 100).toFixed(0)}%</div><div class="metric-label">Pass Rate</div></div>
  </div>

  <div class="metrics">
    <div class="metric"><div class="metric-value">${summary.avgTurns.toFixed(1)}</div><div class="metric-label">Avg Turns</div></div>
    <div class="metric"><div class="metric-value">${summary.avgTokens.toFixed(0)}</div><div class="metric-label">Avg Tokens</div></div>
    <div class="metric"><div class="metric-value">${(summary.p50DurationMs / 1000).toFixed(1)}s</div><div class="metric-label">p50 Duration</div></div>
    <div class="metric"><div class="metric-value">${(summary.p95DurationMs / 1000).toFixed(1)}s</div><div class="metric-label">p95 Duration</div></div>
  </div>

  <table>
    <thead>
      <tr><th>Test</th><th>Status</th><th>Duration</th><th>Turns</th><th>Verdict</th></tr>
    </thead>
    <tbody>
      ${suite.results.map((r) => {
        const cls = r.skipped ? 'skipped' : r.verified ? 'passed' : 'failed';
        const label = r.skipped ? 'SKIP' : r.verified ? 'PASS' : 'FAIL';
        return `
        <tr>
          <td>${r.testCase.name}</td>
          <td class="${cls}">${label}</td>
          <td>${r.skipped ? '-' : (r.durationMs / 1000).toFixed(1) + 's'}</td>
          <td>${r.turnsUsed}</td>
          <td>${esc(r.verdict)}</td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>
</body>
</html>`;
}

/** Compare two suite results (e.g., before/after improvement) */
export function compareReports(before: TestSuiteResult, after: TestSuiteResult): string {
  const lines: string[] = [];

  lines.push('# Test Suite Comparison\n');
  lines.push(`**Before:** ${before.model} (${before.timestamp})`);
  lines.push(`**After:** ${after.model} (${after.timestamp})\n`);

  const bSum = before.summary;
  const aSum = after.summary;

  lines.push('| Metric | Before | After | Delta |');
  lines.push('|--------|--------|-------|-------|');

  const delta = (a: number, b: number, fmt: (n: number) => string) => {
    const d = a - b;
    const sign = d > 0 ? '+' : '';
    return `${sign}${fmt(d)}`;
  };

  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const dec1 = (n: number) => n.toFixed(1);
  const sec = (n: number) => `${(n / 1000).toFixed(1)}s`;

  lines.push(`| Pass Rate | ${pct(bSum.passRate)} | ${pct(aSum.passRate)} | ${delta(aSum.passRate, bSum.passRate, pct)} |`);
  lines.push(`| Passed | ${bSum.passed} | ${aSum.passed} | ${delta(aSum.passed, bSum.passed, dec1)} |`);
  lines.push(`| Avg Turns | ${dec1(bSum.avgTurns)} | ${dec1(aSum.avgTurns)} | ${delta(aSum.avgTurns, bSum.avgTurns, dec1)} |`);
  lines.push(`| Avg Duration | ${sec(bSum.avgDurationMs)} | ${sec(aSum.avgDurationMs)} | ${delta(aSum.avgDurationMs, bSum.avgDurationMs, sec)} |`);

  // Per-test comparison
  lines.push('\n## Per-Test Comparison\n');
  lines.push('| Test | Before | After |');
  lines.push('|------|--------|-------|');

  for (const afterResult of after.results) {
    const beforeResult = before.results.find((r) => r.testCase.id === afterResult.testCase.id);
    const bStatus = beforeResult ? (beforeResult.verified ? 'PASS' : 'FAIL') : 'N/A';
    const aStatus = afterResult.verified ? 'PASS' : 'FAIL';
    lines.push(`| ${esc(afterResult.testCase.name)} | ${bStatus} | ${aStatus} |`);
  }

  return lines.join('\n');
}

/** Escape pipe and newline for markdown table cells */
function esc(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
