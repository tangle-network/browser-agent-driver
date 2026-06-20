import * as fs from 'node:fs';

/**
 * Read the package version for telemetry + the run banner. The URL is relative
 * to this module's compiled location (`dist/cli/version.js`), so `../../`
 * resolves to the package root next to `dist/`.
 */
export function readCliVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
