import fs from 'node:fs';
import path from 'node:path';

export function verifyScenarioArtifacts({ scenarioId, summaryPath, runs }) {
  const scenarioDir = summaryPath ? path.dirname(path.resolve(summaryPath)) : null;
  const checks = [];
  if (!Array.isArray(runs) || runs.length === 0) {
    checks.push({
      scenarioId,
      mode: 'all',
      passed: false,
      failures: ['missing mode run outputs'],
      files: {},
      recording: { exists: false, source: 'none', path: '' },
    });
    return checks;
  }

  for (const run of runs) {
    const mode = String(run?.mode || 'unknown');
    const defaultModeDir = scenarioDir ? path.join(scenarioDir, mode) : null;
    const reportPath = run?.reportPath
      ? path.resolve(run.reportPath)
      : defaultModeDir
        ? path.join(defaultModeDir, 'report.json')
        : '';
    const modeDir = reportPath ? path.dirname(reportPath) : (defaultModeDir ?? '');
    checks.push(verifyModeArtifacts({ scenarioId, mode, modeDir, reportPath }));
  }

  return checks;
}

export function verifyModeArtifacts({ scenarioId, mode, modeDir, reportPath }) {
  const requiredFiles = [
    { key: 'report', path: reportPath },
    { key: 'manifest', path: path.join(modeDir, 'manifest.json') },
    { key: 'suiteReport', path: path.join(modeDir, 'suite', 'report.json') },
    { key: 'suiteManifest', path: path.join(modeDir, 'suite', 'manifest.json') },
  ];

  const failures = [];
  const fileChecks = {};
  for (const required of requiredFiles) {
    const exists = required.path ? fs.existsSync(required.path) : false;
    const sizeBytes = exists ? fs.statSync(required.path).size : 0;
    fileChecks[required.key] = { exists, sizeBytes, path: required.path };
    if (!exists || sizeBytes === 0) {
      failures.push(`missing/non-empty ${required.key}`);
    }
  }

  const recording = detectVideoArtifact(modeDir, [
    path.join(modeDir, 'manifest.json'),
    path.join(modeDir, 'suite', 'manifest.json'),
  ]);
  if (!recording.exists) {
    failures.push('missing recording artifact');
  }

  return {
    scenarioId,
    mode,
    passed: failures.length === 0,
    failures,
    files: fileChecks,
    recording,
  };
}

export function summarizeArtifactChecks(rows) {
  const checks = Array.isArray(rows) ? rows : [];
  return {
    total: checks.length,
    passed: checks.filter((row) => row?.passed).length,
    failed: checks.filter((row) => !row?.passed).length,
    rows: checks,
  };
}

export function formatArtifactCheckFailures(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => !row?.passed)
    .map((row) => `${row.scenarioId} (${row.mode}) artifact check failed: ${row.failures.join('; ')}`);
}

function detectVideoArtifact(modeDir, manifestPaths) {
  for (const manifestPath of manifestPaths) {
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      if (!Array.isArray(manifest)) continue;
      const hit = manifest.find((entry) => entry?.type === 'video' && Number(entry?.sizeBytes || 0) > 0);
      if (hit) {
        return { exists: true, source: 'manifest', path: manifestPath };
      }
    } catch {
      // Best effort parsing.
    }
  }

  const fallbackPaths = [path.join(modeDir, 'cli-task', 'recording.webm')];
  for (const fallbackPath of fallbackPaths) {
    if (!fs.existsSync(fallbackPath)) continue;
    if (fs.statSync(fallbackPath).size > 0) {
      return { exists: true, source: 'file', path: fallbackPath };
    }
  }

  const videosDir = path.join(modeDir, '_videos');
  if (fs.existsSync(videosDir)) {
    const hasVideo = fs.readdirSync(videosDir)
      .filter((name) => name.endsWith('.webm'))
      .some((name) => fs.statSync(path.join(videosDir, name)).size > 0);
    if (hasVideo) {
      return { exists: true, source: 'videos-dir', path: videosDir };
    }
  }

  return { exists: false, source: 'none', path: '' };
}
