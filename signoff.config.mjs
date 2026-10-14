/**
 * The Node 22 merge gate. Keep these checks aligned with ci.yml.
 * See docs/SIGNOFF.md for the Node 20 and host/browser coverage limits.
 */
export default {
  nodeVersion: '22',
  install: {
    // Override a host ignore-scripts setting: dependency setup is part of proof.
    run: 'pnpm install --frozen-lockfile --ignore-scripts=false',
  },
  maxParallel: 4,
  steps: [
    {
      name: 'check changesets',
      run: 'pnpm run check:changesets',
      timeoutMs: 15 * 60_000,
    },
    {
      name: 'check boundaries',
      run: 'pnpm run check:boundaries',
      timeoutMs: 15 * 60_000,
    },
    {
      // tsc already type-checks while building; do not also run tsc --noEmit.
      name: 'build',
      run: 'pnpm run build',
      timeoutMs: 15 * 60_000,
    },
    {
      // OS libraries remain the host's responsibility; CI uses --with-deps.
      name: 'playwright browsers',
      run: 'pnpm exec playwright install chromium',
      timeoutMs: 15 * 60_000,
    },
    {
      // `run` forwards shuffle flags. CLI tests need the completed dist build.
      name: 'unit tests',
      run: 'pnpm run test',
      needs: ['playwright browsers', 'build'],
      shuffle: true,
      timeoutMs: 15 * 60_000,
    },
  ],
}
