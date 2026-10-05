import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('enforces staged changesets through the script and installed pre-commit hook', () => {
  const result = spawnSync('sh', [fileURLToPath(new URL('./check-changeset.sh', import.meta.url))], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
