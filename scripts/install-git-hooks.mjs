import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// A checkout (including a worktree) has its own .git entry. Do not configure a
// parent consumer repository when running from an archive or installed package.
if (existsSync(new URL('../.git', import.meta.url))) {
  execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], {
    cwd: root,
    stdio: 'inherit',
  });
}
