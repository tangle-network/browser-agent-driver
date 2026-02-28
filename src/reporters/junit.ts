/**
 * JUnit XML Reporter — produces standard JUnit XML that GitHub Actions,
 * Jenkins, and GitLab CI parse natively.
 */

import type { TestSuiteResult, TestResult } from '../types.js';

/** Escape special XML characters */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Generate JUnit XML from a test suite result */
export function generateJUnitXml(suite: TestSuiteResult): string {
  const { summary, results } = suite;
  const totalTimeSeconds = (summary.totalDurationMs / 1000).toFixed(3);

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<testsuites name="agent-browser-driver" tests="${summary.total}" failures="${summary.failed}" errors="0" skipped="${summary.skipped}" time="${totalTimeSeconds}">`,
  );

  // Group by category (or "default" if none)
  const groups = groupByCategory(results);

  for (const [category, tests] of groups) {
    const groupFailed = tests.filter((r) => !r.skipped && !r.verified).length;
    const groupSkipped = tests.filter((r) => r.skipped).length;
    const groupTime = tests.reduce((sum, r) => sum + r.durationMs, 0) / 1000;

    lines.push(
      `  <testsuite name="${escapeXml(category)}" tests="${tests.length}" failures="${groupFailed}" errors="0" skipped="${groupSkipped}" time="${groupTime.toFixed(3)}" timestamp="${suite.timestamp}">`,
    );

    for (const result of tests) {
      const testTime = (result.durationMs / 1000).toFixed(3);
      const classname = escapeXml(result.testCase.category || result.testCase.id);
      const testName = escapeXml(result.testCase.name);

      if (result.skipped) {
        lines.push(`    <testcase name="${testName}" classname="${classname}" time="0">`);
        lines.push(`      <skipped message="${escapeXml(result.skipReason || 'Unmet dependency')}"/>`);
        lines.push('    </testcase>');
      } else if (!result.verified) {
        lines.push(`    <testcase name="${testName}" classname="${classname}" time="${testTime}">`);
        lines.push(formatFailure(result));
        lines.push('    </testcase>');
      } else {
        lines.push(`    <testcase name="${testName}" classname="${classname}" time="${testTime}">`);
        lines.push('    </testcase>');
      }
    }

    lines.push('  </testsuite>');
  }

  lines.push('</testsuites>');
  return lines.join('\n');
}

function formatFailure(result: TestResult): string {
  const message = escapeXml(result.verdict.slice(0, 200));
  const bodyLines: string[] = [];

  // Verdict
  bodyLines.push(`Verdict: ${result.verdict}`);

  // Criteria failures
  if (result.criteriaResults?.length) {
    const failed = result.criteriaResults.filter((c) => !c.passed);
    if (failed.length > 0) {
      bodyLines.push('Failed criteria:');
      for (const c of failed) {
        const desc = c.criterion.description || c.criterion.type;
        bodyLines.push(`  - ${desc}${c.detail ? ': ' + c.detail : ''}`);
      }
    }
  }

  // Last actions for debugging
  const lastTurns = result.agentResult.turns.slice(-5);
  if (lastTurns.length > 0) {
    bodyLines.push('Last actions:');
    for (const t of lastTurns) {
      const actionStr = JSON.stringify(t.action).slice(0, 120);
      bodyLines.push(`  [turn ${t.turn}] ${actionStr}`);
    }
  }

  // Escape the entire body text — it's XML CDATA content
  const escapedBody = escapeXml(bodyLines.join('\n'));

  const lines: string[] = [];
  lines.push(`      <failure message="${message}" type="verification">`);
  lines.push(escapedBody);
  lines.push('      </failure>');
  return lines.join('\n');
}

function groupByCategory(results: TestResult[]): Map<string, TestResult[]> {
  const groups = new Map<string, TestResult[]>();

  for (const result of results) {
    const category = result.testCase.category || 'default';
    const group = groups.get(category);
    if (group) {
      group.push(result);
    } else {
      groups.set(category, [result]);
    }
  }

  return groups;
}
