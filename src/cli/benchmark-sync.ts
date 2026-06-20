import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { cliWarn } from '../cli-ui.js';

/**
 * Best-effort import of a finished run into the local abd-app benchmark store.
 * abd-app lives as a sibling of this package's root; the `..` chain walks up
 * from this module's compiled location (`dist/cli/benchmark-sync.js`) to that
 * sibling. Disabled with ABD_BENCHMARK_SYNC=0; strict failures gated by
 * ABD_BENCHMARK_SYNC_STRICT=1.
 */
export async function syncLocalBenchmarkRun(outPath: string, label: string): Promise<void> {
  if (process.env.ABD_BENCHMARK_SYNC === '0') return;
  const importerPath = path.resolve(
    path.join(new URL('.', import.meta.url).pathname, '..', '..', '..', 'abd-app', 'worker', 'scripts', 'import-local-benchmarks.mjs'),
  );
  if (!fs.existsSync(importerPath)) return;
  if (!fs.existsSync(outPath)) return;

  const args = [importerPath, '--path', outPath, '--label', label];
  const userEmail = process.env.ABD_BENCHMARK_USER_EMAIL;
  if (userEmail) args.push('--user-email', userEmail);

  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn('node', args, {
      cwd: path.dirname(importerPath),
      env: {
        ...process.env,
        ABD_BENCHMARK_SYNC: '0',
      },
      stdio: 'inherit',
    });
    child.once('error', () => resolve(1));
    child.once('close', (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    if (process.env.ABD_BENCHMARK_SYNC_STRICT === '1') {
      throw new Error(`abd-app benchmark import failed for ${outPath}`);
    }
    cliWarn(`abd-app benchmark import skipped after non-zero exit for ${outPath}`);
  }
}
