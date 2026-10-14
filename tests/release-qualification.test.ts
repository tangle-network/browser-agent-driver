import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const releaseCheck = join(root, 'scripts/check-release-plan.mjs');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const temporaryDirectories: string[] = [];

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'bad-release-check-'));
  temporaryDirectories.push(cwd);
  mkdirSync(join(cwd, '.changeset'));
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version }));
  writeFileSync(join(cwd, '.changeset/config.json'), readFileSync(join(root, '.changeset/config.json')));
  return cwd;
}

afterEach(() => {
  for (const cwd of temporaryDirectories.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

describe('Changesets release qualification', () => {
  it.each([
    ['patch frontmatter', `---\n"${pkg.name}": patch\n---\n\nRefresh dependencies.\n`, true],
    ['empty changeset', '---\n---\n\nInternal changes.\n', true],
    ['old JSON format', JSON.stringify({ [pkg.name]: 'patch' }), false],
    ['unknown package', '---\n"missing-package": patch\n---\n\nRefresh dependencies.\n', false],
  ])('%s is checked by the Changesets release planner', (_name, contents, valid) => {
    const cwd = fixture();
    writeFileSync(join(cwd, '.changeset/test.md'), contents);
    const result = spawnSync(process.execPath, [releaseCheck], { cwd, encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.status === 0, result.stdout + result.stderr).toBe(valid);
  });

  it('accepts a versioned release with no remaining changesets or base-branch history', () => {
    const cwd = fixture();
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: pkg.name, version: '0.99.0' }));
    const result = spawnSync(process.execPath, [releaseCheck], { cwd, encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});

describe('one type-checking build', () => {
  it('still rejects type errors before copying assets', () => {
    const cwd = fixture();
    mkdirSync(join(cwd, 'src'));
    mkdirSync(join(cwd, 'scripts'));
    writeFileSync(join(cwd, 'tsconfig.json'), readFileSync(join(root, 'tsconfig.json')));
    writeFileSync(join(cwd, 'src/example.ts'), 'const message: string = 123;\n');
    writeFileSync(join(cwd, 'scripts/copy-static-assets.mjs'), 'throw new Error("asset copy should not run");\n');
    const result = spawnSync('sh', ['-c', pkg.scripts.build], {
      cwd,
      env: { ...process.env, PATH: `${join(root, 'node_modules/.bin')}${delimiter}${process.env.PATH}` },
      encoding: 'utf8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('TS2322');
    expect(result.stdout + result.stderr).not.toContain('asset copy should not run');
  });
});

// Exercise the workflow's actual shell body without dispatching, querying npm,
// tagging, or publishing. These fixtures test rejection/ordering, not npm health.
function publishValidation() {
  const workflow = readFileSync(join(root, '.github/workflows/publish-npm.yml'), 'utf8');
  const start = workflow.indexOf('      - name: Validate publish target\n');
  const install = workflow.indexOf('      - name: Install dependencies\n');
  expect(start).toBeGreaterThan(-1);
  expect(start).toBeLessThan(install);
  return workflow.slice(start, install).split('        run: |\n')[1]
    .split('\n').map((line) => line.startsWith('          ') ? line.slice(10) : line).join('\n');
}

describe('release handoff', () => {
  it.each([
    ['workflow_dispatch', 'wrong-version', '', '', 1, false, 'E404'],
    ['workflow_dispatch', pkg.version, '', '', 0, true, 'E404'],
    ['push', '', 'tag', `browser-agent-driver-v${pkg.version}`, 0, true, 'E404'],
    ['push', '', 'tag', 'unrelated-v1.0.0', 1, false, 'E404'],
    ['workflow_dispatch', pkg.version, '', '', 1, true, 'published'],
    ['workflow_dispatch', pkg.version, '', '', 1, true, 'ETIMEDOUT'],
    ['workflow_dispatch', pkg.version, '', '', 1, true, 'E401'],
    ['workflow_dispatch', pkg.version, '', '', 1, true, 'malformed'],
    ['workflow_dispatch', '$(touch injected)', '', '', 1, false, 'E404'],
  ])('validates %s %s %s %s before dependency setup', (event, version, refType, refName, status, queriedNpm, registryStatus) => {
    const cwd = fixture();
    mkdirSync(join(cwd, 'bin'));
    const response = registryStatus === 'malformed' ? '<html>unavailable</html>'
      : registryStatus === 'published' ? JSON.stringify(pkg.version) : JSON.stringify({ error: { code: registryStatus } });
    writeFileSync(join(cwd, 'bin/npm'), `#!/bin/sh\nprintf queried > "$PWD/npm-query"\nprintf '%s' '${response}'\nexit ${registryStatus === 'published' ? 0 : 1}\n`, { mode: 0o755 });
    const script = publishValidation();
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
      cwd,
      env: {
        ...process.env, PATH: `${join(cwd, 'bin')}${delimiter}${process.env.PATH}`,
        GITHUB_REF_TYPE: refType, GITHUB_REF_NAME: refName, GITHUB_OUTPUT: join(cwd, 'outputs'),
        RELEASE_EVENT: event, REQUESTED_VERSION: version,
      },
      encoding: 'utf8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(status);
    expect(() => readFileSync(join(cwd, 'injected'))).toThrow();
    if (queriedNpm) {
      expect(readFileSync(join(cwd, 'npm-query'), 'utf8')).toBe('queried');
      if (status === 0) expect(readFileSync(join(cwd, 'outputs'), 'utf8')).toBe(`version=${pkg.version}\n`);
      else expect(() => readFileSync(join(cwd, 'outputs'))).toThrow();
    } else {
      expect(() => readFileSync(join(cwd, 'npm-query'))).toThrow();
    }
  });

  it('dispatches publication at the package version tag', () => {
    const cwd = fixture();
    mkdirSync(join(cwd, 'bin'));
    writeFileSync(join(cwd, 'bin/gh'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$PWD/dispatch-args"\n', { mode: 0o755 });
    const workflow = readFileSync(join(root, '.github/workflows/changesets.yml'), 'utf8');
    const script = workflow.split('      - name: Trigger publish workflow\n')[1]
      .split('        run: |\n')[1].split('\n')
      .map((line) => line.startsWith('          ') ? line.slice(10) : line).join('\n');
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
      cwd, env: { ...process.env, PATH: `${join(cwd, 'bin')}${delimiter}${process.env.PATH}` }, encoding: 'utf8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(join(cwd, 'dispatch-args'), 'utf8').trim().split('\n')).toEqual([
      'workflow', 'run', 'publish-npm.yml', '--ref', `browser-agent-driver-v${pkg.version}`, '-f', `version=${pkg.version}`,
    ]);
  });
});
