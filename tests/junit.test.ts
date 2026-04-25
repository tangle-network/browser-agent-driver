import { describe, it, expect } from 'vitest';
import { generateJUnitXml } from '../src/reporters/junit.js';
import type { TestSuiteResult, TestResult, TestCase, AgentResult } from '../src/types.js';

function makeTestCase(overrides?: Partial<TestCase>): TestCase {
  return {
    id: 'test-1',
    name: 'Test case 1',
    startUrl: 'http://localhost:3000',
    goal: 'Complete the flow',
    ...overrides,
  };
}

function makeAgentResult(overrides?: Partial<AgentResult>): AgentResult {
  return {
    success: true,
    turns: [],
    totalMs: 5000,
    ...overrides,
  };
}

function makeTestResult(overrides?: Partial<TestResult>): TestResult {
  return {
    testCase: makeTestCase(),
    agentResult: makeAgentResult(),
    agentSuccess: true,
    verified: true,
    verdict: 'All criteria met',
    turnsUsed: 10,
    tokensUsed: 500,
    durationMs: 5000,
    startedAt: new Date('2026-01-15T10:00:00Z'),
    endedAt: new Date('2026-01-15T10:00:05Z'),
    ...overrides,
  };
}

function makeSuite(results: TestResult[], overrides?: Partial<TestSuiteResult>): TestSuiteResult {
  const passed = results.filter((r) => !r.skipped && r.verified).length;
  const failed = results.filter((r) => !r.skipped && !r.verified).length;
  const skipped = results.filter((r) => r.skipped).length;
  const total = results.length;

  return {
    schemaVersion: '1',
    model: 'gpt-4o',
    timestamp: '2026-01-15T10:00:00Z',
    results,
    summary: {
      total,
      passed,
      failed,
      skipped,
      passRate: total > 0 ? passed / total : 0,
      avgTurns: 10,
      avgTokens: 500,
      avgDurationMs: 5000,
      p50DurationMs: 5000,
      p95DurationMs: 8000,
      totalDurationMs: results.reduce((sum, r) => sum + r.durationMs, 0),
    },
    ...overrides,
  };
}

describe('generateJUnitXml', () => {
  it('produces valid XML with correct header', () => {
    const suite = makeSuite([makeTestResult()]);
    const xml = generateJUnitXml(suite);

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<testsuites name="browser-agent-driver"');
    expect(xml).toContain('</testsuites>');
  });

  it('includes correct test counts in testsuites element', () => {
    const suite = makeSuite([
      makeTestResult({ verified: true }),
      makeTestResult({ verified: false, testCase: makeTestCase({ id: 'test-2', name: 'Failing test' }) }),
    ]);

    const xml = generateJUnitXml(suite);
    expect(xml).toContain('tests="2"');
    expect(xml).toContain('failures="1"');
  });

  it('marks passing tests as empty testcase elements', () => {
    const suite = makeSuite([makeTestResult()]);
    const xml = generateJUnitXml(suite);

    expect(xml).toContain('name="Test case 1"');
    expect(xml).not.toContain('<failure');
  });

  it('includes failure details for failed tests', () => {
    const suite = makeSuite([
      makeTestResult({
        verified: false,
        verdict: 'Element not found: submit button',
        agentResult: makeAgentResult({
          turns: [
            { turn: 1, state: { url: 'http://localhost', title: '', snapshot: '' }, action: { action: 'click', selector: '@b1' }, durationMs: 100 },
          ],
        }),
      }),
    ]);

    const xml = generateJUnitXml(suite);
    expect(xml).toContain('<failure');
    expect(xml).toContain('Element not found');
    expect(xml).toContain('</failure>');
  });

  it('includes skipped tests with reason', () => {
    const suite = makeSuite([
      makeTestResult({
        skipped: true,
        skipReason: 'Dependency test-0 failed',
        verified: false,
        durationMs: 0,
        turnsUsed: 0,
      }),
    ]);

    const xml = generateJUnitXml(suite);
    expect(xml).toContain('<skipped');
    expect(xml).toContain('Dependency test-0 failed');
  });

  it('escapes special XML characters in names and verdicts', () => {
    const suite = makeSuite([
      makeTestResult({
        testCase: makeTestCase({ name: 'Test <with> "special" & chars' }),
        verdict: 'Failed: expected <button> & got "nothing"',
        verified: false,
      }),
    ]);

    const xml = generateJUnitXml(suite);
    expect(xml).toContain('&lt;with&gt;');
    expect(xml).toContain('&amp;');
    expect(xml).toContain('&quot;special&quot;');
    expect(xml).not.toContain('Test <with>');
  });

  it('groups tests by category into testsuites', () => {
    const suite = makeSuite([
      makeTestResult({ testCase: makeTestCase({ id: 'a', name: 'Auth test', category: 'auth' }) }),
      makeTestResult({ testCase: makeTestCase({ id: 'b', name: 'Billing test', category: 'billing' }) }),
      makeTestResult({ testCase: makeTestCase({ id: 'c', name: 'Another auth', category: 'auth' }) }),
    ]);

    const xml = generateJUnitXml(suite);
    // Should have two testsuite elements
    const matches = xml.match(/<testsuite /g);
    expect(matches).toHaveLength(2);
    expect(xml).toContain('name="auth"');
    expect(xml).toContain('name="billing"');
  });

  it('escapes XML chars in failure body text (verdict + action JSON)', () => {
    const suite = makeSuite([
      makeTestResult({
        verified: false,
        verdict: 'Expected <div class="active"> & found <span>',
        agentResult: makeAgentResult({
          turns: [
            {
              turn: 1,
              state: { url: 'http://localhost', title: '', snapshot: '' },
              action: { action: 'click', selector: '[data-testid="btn<1>"]' },
              durationMs: 100,
            },
          ],
        }),
      }),
    ]);

    const xml = generateJUnitXml(suite);

    // The body text between <failure> and </failure> must be escaped
    expect(xml).not.toContain('<div class="active">');
    expect(xml).toContain('&lt;div class=');
    // Action JSON in body must also be escaped
    expect(xml).not.toContain('btn<1>');
    expect(xml).toContain('btn&lt;1&gt;');
  });

  it('handles empty suite', () => {
    const suite = makeSuite([]);
    const xml = generateJUnitXml(suite);

    expect(xml).toContain('tests="0"');
    expect(xml).toContain('failures="0"');
    expect(xml).toContain('</testsuites>');
  });
});
