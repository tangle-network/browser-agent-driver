import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

describe('reliability scorecard', () => {
  it('uses runtime-log evidence to classify failures', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abd-scorecard-'));
    const suiteDir = path.join(root, 'scenario-a', 'full-evidence', 'suite');
    const testDir = path.join(root, 'scenario-a', 'full-evidence', 'login');
    fs.mkdirSync(suiteDir, { recursive: true });
    fs.mkdirSync(testDir, { recursive: true });

    fs.writeFileSync(
      path.join(suiteDir, 'report.json'),
      JSON.stringify({
        results: [
          {
            testCase: {
              id: 'login',
              name: 'Login',
              startUrl: 'https://app.example.com/login',
            },
            verified: false,
            verdict: 'Failed',
            agentResult: { success: false, reason: 'Failed' },
            turnsUsed: 4,
            durationMs: 1000,
            tokensUsed: 20,
          },
        ],
      }),
    );

    fs.writeFileSync(
      path.join(testDir, 'runtime-log.json'),
      JSON.stringify({
        responseErrors: [
          { status: '403', statusText: 'Forbidden', url: 'https://app.example.com/api/me' },
        ],
        console: [],
        pageErrors: [],
        requestFailures: [],
      }),
    );

    const stdout = execFileSync(
      'node',
      ['scripts/reliability-scorecard.mjs', '--root', root],
      {
        cwd: '/Users/drew/webb/agent-browser-driver',
        encoding: 'utf-8',
      },
    );

    const scorecard = JSON.parse(stdout);
    expect(scorecard.failed).toBe(1);
    expect(scorecard.runtimeSignals.present).toBe(1);
    expect(scorecard.runtimeSignals.classifiedFromRuntime).toBe(1);
    expect(scorecard.topFailures[0]?.class).toBe('auth_or_permissions');
    expect(scorecard.topFailures[0]?.classificationSource).toBe('runtime-log');
  });
});
