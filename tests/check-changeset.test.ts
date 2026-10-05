import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, it } from 'vitest';

const source = fileURLToPath(new URL('../', import.meta.url));
const script = join(source, 'scripts/check-changeset.sh');
let root: string;
let env: NodeJS.ProcessEnv;

function git(...args: string[]) {
  return execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function write(path: string, content = 'changed\n') {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function stage(path: string, content = 'changed\n') {
  write(path, content);
  git('add', '--', path);
}

function check(status: number, cwd = root) {
  const result = spawnSync('sh', [script], { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, status, result.stderr);
  if (status === 1) assert.match(result.stderr, /require a staged changeset/);
}

function installHook(cwd = root) {
  for (const path of ['package.json', 'scripts/install-git-hooks.mjs', 'scripts/check-changeset.sh', '.githooks/pre-commit']) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    copyFileSync(join(source, path), join(cwd, path));
  }
  assert.ok(statSync(join(cwd, '.githooks/pre-commit')).mode & 0o111, 'hook must be executable in Git');
  const result = spawnSync('npm', ['run', 'prepare'], { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'changeset guard '));
  // Do not inherit a hook's GIT_INDEX_FILE/GIT_DIR or a developer's Git config.
  env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = join(root, 'no-global-config');
  git('init', '--quiet');
  git('config', 'user.name', 'Changeset test');
  git('config', 'user.email', 'changeset-test@example.invalid');
  git('config', 'commit.gpgSign', 'false');
  for (const path of ['README.md', 'src/existing.ts', 'bench/existing.ts', '.changeset/existing.md', '.changeset/README.md']) {
    stage(path, 'baseline\n');
  }
  git('commit', '--quiet', '-m', 'baseline');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

for (const path of ['src/new.ts', 'bench/new.ts', 'src/space name.ts', 'bench/雪\nname.ts']) {
  it(`rejects ${JSON.stringify(path)} without a staged changeset`, () => {
    stage(path);
    check(1);
  });
}

for (const path of ['src/new.ts', 'bench/new.ts']) {
  it(`accepts ${path} with a staged new changeset`, () => {
    stage(path);
    stage('.changeset/new-note.md', '---\n"@tangle-network/browser-agent-driver": patch\n---\n\nTest change.\n');
    check(0);
  });
}

it('accepts a modified changeset', () => {
  stage('src/new.ts');
  stage('.changeset/existing.md');
  check(0);
});

for (const path of ['.changeset/untracked.md', '.changeset/existing.md']) {
  it(`ignores unstaged ${path}`, () => {
    stage('src/new.ts');
    write(path);
    check(1);
  });
}

for (const path of ['.changeset/README.md', '.changeset/nested/note.md', '.changeset/note.txt']) {
  it(`does not count ${path} as a changeset`, () => {
    stage('bench/new.ts');
    stage(path);
    check(1);
  });
}

it('does not count a deleted changeset', () => {
  stage('src/new.ts');
  git('rm', '.changeset/existing.md');
  check(1);
});

it('accepts a renamed changeset that remains in the index', () => {
  stage('src/new.ts');
  git('mv', '.changeset/existing.md', '.changeset/renamed.md');
  check(0);
});

for (const path of ['src/existing.ts', 'bench/existing.ts']) {
  it(`checks deletion of ${path}`, () => {
    git('rm', path);
    check(1);
  });
}

it('checks a rename out of src/', () => {
  git('mv', 'src/existing.ts', 'moved.ts');
  check(1);
});

it('checks a rename into bench/', () => {
  git('mv', 'README.md', 'bench/README.md');
  check(1);
});

it('allows an empty index', () => check(0));

it('allows docs-only staging despite unstaged source edits', () => {
  stage('README.md');
  write('src/existing.ts');
  check(0);
});

it('checks from a subdirectory', () => {
  stage('bench/new.ts');
  check(1, join(root, 'src'));
});

for (const path of ['src/new.ts', 'bench/new.ts']) {
  it(`installs the hook and blocks git commit for ${path} until a changeset is staged`, () => {
    installHook();
    assert.equal(git('config', '--local', 'core.hooksPath'), '.githooks');
    stage(path);
    const head = git('rev-parse', 'HEAD');
    const blocked = spawnSync('git', ['commit', '-m', 'missing changeset'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(blocked.status, 1, blocked.stderr);
    assert.match(blocked.stderr, /require a staged changeset/);
    assert.equal(git('rev-parse', 'HEAD'), head);
    stage('.changeset/valid.md');
    git('commit', '--quiet', '-m', 'with changeset');
    assert.notEqual(git('rev-parse', 'HEAD'), head);
  });
}

it('allows the documented git commit --no-verify opt-out', () => {
  installHook();
  stage('src/new.ts');
  git('commit', '--quiet', '--no-verify', '-m', 'intentional exception');
  assert.match(readFileSync(join(source, 'CLAUDE.md'), 'utf8'), /git commit --no-verify/);
});

it('does not reconfigure a consumer repository when installed without its own .git', () => {
  git('config', 'core.hooksPath', 'consumer-hooks');
  installHook(join(root, 'node_modules', 'browser-agent-driver'));
  assert.equal(git('config', 'core.hooksPath'), 'consumer-hooks');
});

it('installs in a linked worktree with a .git file', () => {
  const worktree = join(root, 'linked-worktree');
  git('worktree', 'add', '--quiet', '--detach', worktree, 'HEAD');
  assert.ok(statSync(join(worktree, '.git')).isFile());
  installHook(worktree);
  execFileSync('git', ['rm', 'src/existing.ts'], { cwd: worktree, env, stdio: 'pipe' });
  const result = spawnSync('git', ['commit', '-m', 'missing changeset'], { cwd: worktree, env, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /require a staged changeset/);
});
