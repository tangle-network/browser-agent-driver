import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { summarizeArtifactChecks, verifyModeArtifacts, verifyScenarioArtifacts } from '../scripts/lib/artifact-completeness.mjs';

describe('artifact completeness', () => {
  it('passes when required files and recording artifact exist', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abd-artifacts-'));
    const modeDir = path.join(root, 'full-evidence');
    fs.mkdirSync(path.join(modeDir, 'suite'), { recursive: true });
    fs.mkdirSync(path.join(modeDir, 'cli-task'), { recursive: true });
    fs.writeFileSync(path.join(modeDir, 'report.json'), '{"ok":true}\n');
    fs.writeFileSync(path.join(modeDir, 'manifest.json'), '[]\n');
    fs.writeFileSync(path.join(modeDir, 'suite', 'report.json'), '{"ok":true}\n');
    fs.writeFileSync(path.join(modeDir, 'suite', 'manifest.json'), '[]\n');
    fs.writeFileSync(path.join(modeDir, 'cli-task', 'recording.webm'), 'video');

    const check = verifyModeArtifacts({
      scenarioId: 'login',
      mode: 'full-evidence',
      modeDir,
      reportPath: path.join(modeDir, 'report.json'),
    });

    expect(check.passed).toBe(true);
    expect(check.recording.exists).toBe(true);
  });

  it('reports missing mode outputs at the scenario level', () => {
    const rows = verifyScenarioArtifacts({
      scenarioId: 'login',
      summaryPath: '/tmp/login/baseline-summary.json',
      runs: [],
    });

    expect(rows[0]?.passed).toBe(false);
    expect(rows[0]?.failures).toContain('missing mode run outputs');
    expect(summarizeArtifactChecks(rows).failed).toBe(1);
  });
});
