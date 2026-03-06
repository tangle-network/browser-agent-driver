import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

describe('reliability trend', () => {
  it('appends scorecards and computes delta vs previous run', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abd-trend-'));
    const historyPath = path.join(root, 'local-history.jsonl');
    const scorecardA = path.join(root, 'scorecard-a.json');
    const scorecardB = path.join(root, 'scorecard-b.json');

    fs.writeFileSync(scorecardA, JSON.stringify({
      generatedAt: '2026-03-05T00:00:00.000Z',
      root: '/tmp/run-a',
      totalTests: 2,
      passed: 1,
      failed: 1,
      passRate: 0.5,
      diagnostics: {
        runtimeLogCoverage: 0.5,
        runtimeDrivenClassificationRate: 0.5,
      },
      leaderboard: {
        failureClasses: [{ name: 'auth_or_permissions', count: 1, share: 1 }],
      },
    }));

    fs.writeFileSync(scorecardB, JSON.stringify({
      generatedAt: '2026-03-05T01:00:00.000Z',
      root: '/tmp/run-b',
      totalTests: 2,
      passed: 2,
      failed: 0,
      passRate: 1,
      diagnostics: {
        runtimeLogCoverage: 1,
        runtimeDrivenClassificationRate: 0,
      },
      leaderboard: {
        failureClasses: [],
      },
    }));

    execFileSync('node', [
      'scripts/reliability-trend.mjs',
      '--history', historyPath,
      '--append-scorecard', scorecardA,
      '--profile', 'tier1',
      '--root', '/tmp/run-a',
    ], { cwd: '/Users/drew/webb/agent-browser-driver', encoding: 'utf-8' });

    const stdout = execFileSync('node', [
      'scripts/reliability-trend.mjs',
      '--history', historyPath,
      '--append-scorecard', scorecardB,
      '--profile', 'tier1',
      '--root', '/tmp/run-b',
    ], { cwd: '/Users/drew/webb/agent-browser-driver', encoding: 'utf-8' });

    const trend = JSON.parse(stdout);
    expect(trend.filteredEntries).toBe(2);
    expect(trend.latest.passRate).toBe(1);
    expect(trend.previous.passRate).toBe(0.5);
    expect(trend.delta.passRate).toBe(0.5);
    expect(trend.delta.failed).toBe(-1);
  });
});
