import { describe, expect, it } from 'vitest';
import { generateReport, compareReports } from '../src/test-report.js';
import type { TestSuiteResult, TestResult, TestCase, AgentResult, Turn } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTestCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: 'tc-1',
    name: 'Test Case 1',
    startUrl: 'https://example.com',
    goal: 'Do the thing',
    ...overrides,
  };
}

function makeTurn(turn: number): Turn {
  return {
    turn,
    state: { url: 'https://example.com', title: 'Example', snapshot: 'content' },
    action: { action: 'click', selector: '@b1' },
    durationMs: 100,
  };
}

function makeAgentResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    success: true,
    turns: [makeTurn(1), makeTurn(2)],
    totalMs: 5000,
    ...overrides,
  };
}

function makeTestResult(overrides: Partial<TestResult> = {}): TestResult {
  return {
    testCase: makeTestCase(),
    agentResult: makeAgentResult(),
    agentSuccess: true,
    verified: true,
    verdict: 'All criteria met',
    turnsUsed: 2,
    tokensUsed: 500,
    durationMs: 5000,
    startedAt: new Date('2026-03-07T10:00:00Z'),
    endedAt: new Date('2026-03-07T10:00:05Z'),
    ...overrides,
  };
}

function makeSuite(overrides: Partial<TestSuiteResult> = {}): TestSuiteResult {
  const results = overrides.results ?? [makeTestResult()];
  const passed = results.filter((r) => r.verified && !r.skipped).length;
  const failed = results.filter((r) => !r.verified && !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;
  const total = results.length;
  return {
    model: 'gpt-5.4',
    timestamp: '2026-03-07T10:00:00Z',
    results,
    summary: {
      total,
      passed,
      failed,
      skipped,
      passRate: total > 0 ? passed / total : 0,
      avgTurns: 2,
      avgTokens: 500,
      avgDurationMs: 5000,
      p50DurationMs: 5000,
      p95DurationMs: 5000,
      totalDurationMs: 5000,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// JSON format
// ---------------------------------------------------------------------------

describe('generateReport — JSON', () => {
  it('produces valid JSON', () => {
    const suite = makeSuite();
    const output = generateReport(suite, { format: 'json' });
    const parsed = JSON.parse(output);
    expect(parsed.model).toBe('gpt-5.4');
    expect(parsed.results).toHaveLength(1);
  });

  it('includes all summary fields', () => {
    const suite = makeSuite();
    const output = generateReport(suite, { format: 'json' });
    const parsed = JSON.parse(output);
    expect(parsed.summary).toHaveProperty('total');
    expect(parsed.summary).toHaveProperty('passRate');
    expect(parsed.summary).toHaveProperty('p50DurationMs');
  });
});

// ---------------------------------------------------------------------------
// Markdown format
// ---------------------------------------------------------------------------

describe('generateReport — Markdown', () => {
  it('contains title and model info', () => {
    const suite = makeSuite();
    const md = generateReport(suite, { format: 'markdown' });
    expect(md).toContain('# Test Suite Report');
    expect(md).toContain('gpt-5.4');
  });

  it('includes pass rate', () => {
    const suite = makeSuite();
    const md = generateReport(suite, { format: 'markdown' });
    expect(md).toContain('100.0%');
  });

  it('includes summary table', () => {
    const suite = makeSuite();
    const md = generateReport(suite, { format: 'markdown' });
    expect(md).toContain('## Summary');
    expect(md).toContain('| Metric | Value |');
    expect(md).toContain('| Avg Turns |');
  });

  it('includes results table', () => {
    const suite = makeSuite();
    const md = generateReport(suite, { format: 'markdown' });
    expect(md).toContain('## Results');
    expect(md).toContain('| Test | Category | Agent | Verified | Turns | Tokens | Duration |');
    expect(md).toContain('Test Case 1');
  });

  it('includes runtime info when present', () => {
    const suite = makeSuite({
      runtime: {
        provider: 'openai',
        model: 'gpt-5.4',
        sandboxBackendType: 'docker',
        sandboxBackendProfile: 'default',
      },
    });
    const md = generateReport(suite, { format: 'markdown' });
    expect(md).toContain('**Runtime:**');
    expect(md).toContain('openai');
    expect(md).toContain('docker');
  });

  it('includes failure details section for failed tests', () => {
    const failedResult = makeTestResult({
      verified: false,
      agentSuccess: false,
      verdict: 'Goal not achieved',
    });
    const suite = makeSuite({ results: [failedResult] });
    const md = generateReport(suite, { format: 'markdown' });
    expect(md).toContain('## Failures');
    expect(md).toContain('Goal not achieved');
    expect(md).toContain('**Last actions:**');
  });

  it('does not include failure section when all pass', () => {
    const suite = makeSuite();
    const md = generateReport(suite, { format: 'markdown' });
    expect(md).not.toContain('## Failures');
  });

  it('includes turn logs when requested', () => {
    const suite = makeSuite();
    const md = generateReport(suite, { format: 'markdown', includeTurns: true });
    expect(md).toContain('## Turn Logs');
    expect(md).toContain('Turn 1:');
  });

  it('escapes pipe characters in test names', () => {
    const result = makeTestResult({
      testCase: makeTestCase({ name: 'Test | with pipes' }),
    });
    const suite = makeSuite({ results: [result] });
    const md = generateReport(suite, { format: 'markdown' });
    expect(md).toContain('Test \\| with pipes');
  });

  it('handles skipped tests', () => {
    const skipped = makeTestResult({
      skipped: true,
      skipReason: 'dependency failed',
      verified: false,
    });
    const suite = makeSuite({ results: [skipped] });
    const md = generateReport(suite, { format: 'markdown' });
    expect(md).toContain('SKIP');
  });

  it('includes phase timings in failure details', () => {
    const failedResult = makeTestResult({
      verified: false,
      phaseTimings: {
        initialNavigateMs: 1500,
        firstObserveMs: 800,
        firstDecideMs: 2000,
        firstExecuteMs: 300,
      },
    });
    const suite = makeSuite({ results: [failedResult] });
    const md = generateReport(suite, { format: 'markdown' });
    expect(md).toContain('navigate 1.5s');
    expect(md).toContain('observe 0.8s');
  });

  it('includes waste metrics in failure details', () => {
    const failedResult = makeTestResult({
      verified: false,
      wasteMetrics: {
        repeatedQueryCount: 3,
        verificationRejectionCount: 2,
        turnsAfterSufficientEvidence: 1,
        errorTurns: 4,
      },
    });
    const suite = makeSuite({ results: [failedResult] });
    const md = generateReport(suite, { format: 'markdown' });
    expect(md).toContain('repeated queries 3');
    expect(md).toContain('error turns 4');
  });

  it('includes criteria results in failure details', () => {
    const failedResult = makeTestResult({
      verified: false,
      criteriaResults: [
        { criterion: { type: 'url-contains', description: 'URL check' }, passed: true },
        { criterion: { type: 'element-visible', description: 'Element check' }, passed: false, detail: 'Not found' },
      ],
    });
    const suite = makeSuite({ results: [failedResult] });
    const md = generateReport(suite, { format: 'markdown' });
    expect(md).toContain('[PASS] URL check');
    expect(md).toContain('[FAIL] Element check: Not found');
  });

  it('includes startup diagnostics in failure details', () => {
    const failedResult = makeTestResult({
      verified: false,
      startupDiagnostics: {
        firstTurnSeen: true,
        timeToFirstTurnMs: 3200,
        zeroTurnFailureClass: undefined,
      },
    });
    const suite = makeSuite({ results: [failedResult] });
    const md = generateReport(suite, { format: 'markdown' });
    expect(md).toContain('first turn seen yes');
    expect(md).toContain('time to first turn 3.2s');
  });
});

// ---------------------------------------------------------------------------
// HTML format
// ---------------------------------------------------------------------------

describe('generateReport — HTML', () => {
  it('produces valid HTML document', () => {
    const suite = makeSuite();
    const html = generateReport(suite, { format: 'html' });
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('</html>');
    expect(html).toContain('<title>Test Suite Report</title>');
  });

  it('includes model name', () => {
    const suite = makeSuite();
    const html = generateReport(suite, { format: 'html' });
    expect(html).toContain('gpt-5.4');
  });

  it('includes pass/fail/skip counts', () => {
    const suite = makeSuite();
    const html = generateReport(suite, { format: 'html' });
    expect(html).toContain('Passed');
    expect(html).toContain('Failed');
    expect(html).toContain('Skipped');
  });

  it('includes results table', () => {
    const suite = makeSuite();
    const html = generateReport(suite, { format: 'html' });
    expect(html).toContain('<table>');
    expect(html).toContain('Test Case 1');
    expect(html).toContain('PASS');
  });

  it('marks failed tests with failed class', () => {
    const failedResult = makeTestResult({ verified: false });
    const suite = makeSuite({ results: [failedResult] });
    const html = generateReport(suite, { format: 'html' });
    expect(html).toContain('class="failed"');
    expect(html).toContain('FAIL');
  });

  it('marks skipped tests with skipped class', () => {
    const skipped = makeTestResult({ skipped: true, verified: false });
    const suite = makeSuite({ results: [skipped] });
    const html = generateReport(suite, { format: 'html' });
    expect(html).toContain('class="skipped"');
    expect(html).toContain('SKIP');
  });

  it('includes runtime info', () => {
    const suite = makeSuite({
      runtime: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
    });
    const html = generateReport(suite, { format: 'html' });
    expect(html).toContain('anthropic');
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('generateReport — edge cases', () => {
  it('handles empty results array', () => {
    const suite = makeSuite({
      results: [],
      summary: {
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        passRate: 0,
        avgTurns: 0,
        avgTokens: 0,
        avgDurationMs: 0,
        p50DurationMs: 0,
        p95DurationMs: 0,
        totalDurationMs: 0,
      },
    });
    const md = generateReport(suite, { format: 'markdown' });
    expect(md).toContain('# Test Suite Report');
    expect(md).toContain('0.0%');

    const html = generateReport(suite, { format: 'html' });
    expect(html).toContain('<!DOCTYPE html>');
  });

  it('handles all-failed suite', () => {
    const results = [
      makeTestResult({ verified: false, verdict: 'Fail 1' }),
      makeTestResult({
        testCase: makeTestCase({ id: 'tc-2', name: 'Test 2' }),
        verified: false,
        verdict: 'Fail 2',
      }),
    ];
    const suite = makeSuite({ results });
    const md = generateReport(suite, { format: 'markdown' });
    expect(md).toContain('## Failures');
    expect(md).toContain('Fail 1');
    expect(md).toContain('Fail 2');
  });

  it('throws on unknown format', () => {
    const suite = makeSuite();
    expect(() => generateReport(suite, { format: 'xml' as any })).toThrow('Unknown format');
  });
});

// ---------------------------------------------------------------------------
// compareReports
// ---------------------------------------------------------------------------

describe('compareReports', () => {
  it('produces comparison table', () => {
    const before = makeSuite({ model: 'gpt-5.4', timestamp: '2026-03-06T10:00:00Z' });
    const after = makeSuite({
      model: 'gpt-5.4',
      timestamp: '2026-03-07T10:00:00Z',
      summary: {
        ...makeSuite().summary,
        passRate: 0.8,
        passed: 4,
        avgTurns: 3.5,
      },
    });
    const comparison = compareReports(before, after);
    expect(comparison).toContain('# Test Suite Comparison');
    expect(comparison).toContain('Before');
    expect(comparison).toContain('After');
    expect(comparison).toContain('Delta');
    expect(comparison).toContain('Pass Rate');
  });

  it('includes per-test comparison', () => {
    const before = makeSuite();
    const after = makeSuite({
      results: [
        makeTestResult(),
        makeTestResult({ testCase: makeTestCase({ id: 'tc-new', name: 'New Test' }), verified: false }),
      ],
    });
    const comparison = compareReports(before, after);
    expect(comparison).toContain('## Per-Test Comparison');
    expect(comparison).toContain('Test Case 1');
    expect(comparison).toContain('New Test');
  });

  it('shows N/A for tests not in the before suite', () => {
    const before = makeSuite({ results: [] });
    const after = makeSuite();
    const comparison = compareReports(before, after);
    expect(comparison).toContain('N/A');
  });
});
