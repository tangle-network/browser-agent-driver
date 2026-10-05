import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

// A checkout has its own .git directory (or file for a linked worktree).
// Never configure a consumer's parent repository from an installed package.
if (existsSync(new URL('../.git', import.meta.url))) {
  execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], {
    cwd: root,
    stdio: 'inherit',
  });
}
