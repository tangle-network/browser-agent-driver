import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function benchmarkSyncChildEnv(baseEnv = process.env) {
  return {
    ...baseEnv,
    ABD_BENCHMARK_SYNC: '0',
  };
}

export async function syncBenchmarkOutput({ rootDir, outPath, label, userEmail }) {
  if (process.env.ABD_BENCHMARK_SYNC === '0') {
    return { skipped: true, reason: 'disabled' };
  }

  const importerPath = path.resolve(rootDir, '..', 'abd-app', 'worker', 'scripts', 'import-local-benchmarks.mjs');
  if (!fs.existsSync(importerPath)) {
    return { skipped: true, reason: 'importer-missing' };
  }

  const resolvedOutPath = path.resolve(outPath);
  if (!fs.existsSync(resolvedOutPath)) {
    return { skipped: true, reason: 'output-missing' };
  }

  const args = [importerPath, '--path', resolvedOutPath];
  if (label) args.push('--label', label);
  if (userEmail ?? process.env.ABD_BENCHMARK_USER_EMAIL) {
    args.push('--user-email', userEmail ?? process.env.ABD_BENCHMARK_USER_EMAIL);
  }

  const exitCode = await spawnAndWait('node', args, {
    cwd: path.dirname(importerPath),
    env: benchmarkSyncChildEnv(process.env),
    stdio: 'inherit',
  });

  if (exitCode !== 0) {
    if (process.env.ABD_BENCHMARK_SYNC_STRICT === '1') {
      throw new Error(`abd-app benchmark import failed for ${resolvedOutPath}`);
    }
    console.warn(`abd-app benchmark import skipped after non-zero exit for ${resolvedOutPath}`);
    return { skipped: true, reason: 'importer-failed' };
  }

  return { skipped: false, reason: 'imported' };
}

function spawnAndWait(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    child.once('error', () => resolve(1));
    child.once('close', (code) => resolve(code ?? 1));
  });
}
