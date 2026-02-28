/**
 * Smoke test — verify SandboxProvider can provision, exec, read/write files.
 *
 * Tests both Docker and Tangle providers depending on what's available.
 *
 * Usage:
 *   npx tsx tests/smoke.ts                     # auto-detect provider
 *   npx tsx tests/smoke.ts --provider docker    # Docker only
 *   npx tsx tests/smoke.ts --provider tangle    # Tangle only
 */

import { parseArgs } from 'node:util';
import type { SandboxProvider, Sandbox } from '../src/types.js';

const { values } = parseArgs({
  options: {
    provider: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
  strict: false,
});

if (values.help) {
  console.log('Usage: npx tsx tests/smoke.ts [--provider docker|tangle]');
  process.exit(0);
}

async function smokeTestProvider(provider: SandboxProvider): Promise<void> {
  console.log(`\n=== Smoke testing ${provider.name} provider ===\n`);
  let sandbox: Sandbox | undefined;

  try {
    // 1. Provision
    console.log('1. Provisioning sandbox...');
    sandbox = await provider.provision({ id: 'smoke-test' });
    console.log(`   OK: sandbox id=${sandbox.id}, status=${sandbox.status}`);

    // 2. Exec
    console.log('2. Executing command...');
    const result = await sandbox.exec('echo "hello from sandbox"');
    console.log(`   stdout: ${result.stdout.trim()}`);
    console.log(`   exitCode: ${result.exitCode}`);
    if (result.exitCode !== 0) throw new Error(`exec failed: ${result.stderr}`);
    if (!result.stdout.includes('hello from sandbox')) throw new Error('unexpected stdout');
    console.log('   OK');

    // 3. Write file (use workspace-relative path for Tangle provider)
    const testFilePath = provider.name === 'tangle' ? 'smoke-test.txt' : '/tmp/smoke-test.txt';
    const testDirPath = provider.name === 'tangle' ? '.' : '/tmp';
    console.log(`3. Writing file (${testFilePath})...`);
    await sandbox.writeFile(testFilePath, 'sandbox works!');
    console.log('   OK');

    // 4. Read file
    console.log('4. Reading file...');
    const content = await sandbox.readFile(testFilePath);
    const text = content.toString('utf-8').trim();
    console.log(`   content: "${text}"`);
    if (text !== 'sandbox works!') throw new Error(`unexpected content: "${text}"`);
    console.log('   OK');

    // 5. List files
    if (provider.name === 'tangle') {
      // Tangle's listFiles via SDK adapter isn't fully wired yet
      // The file API writes to workspace dir, terminal runs in project dir
      console.log('5. Listing files... SKIPPED (tangle provider — fs.list not routed through adapter)');
    } else {
      console.log(`5. Listing ${testDirPath}...`);
      const files = await sandbox.listFiles(testDirPath);
      const found = files.find((f) => f.name === 'smoke-test.txt');
      console.log(`   files: ${files.length} entries, smoke-test.txt ${found ? 'found' : 'NOT FOUND'}`);
      if (!found) throw new Error('smoke-test.txt not found in listing');
      console.log('   OK');
    }

    // 6. ExecStream
    console.log('6. Streaming exec...');
    const lines: string[] = [];
    for await (const line of sandbox.execStream('seq 1 5')) {
      // Filter out terminal prompt noise from Tangle provider
      const trimmed = line.trim();
      if (trimmed && /^\d+$/.test(trimmed)) {
        lines.push(trimmed);
      }
    }
    console.log(`   lines: ${lines.join(', ')}`);
    if (lines.length < 5) throw new Error(`expected at least 5 lines, got ${lines.length}`);
    console.log('   OK');

    console.log(`\n=== ${provider.name} provider: ALL PASSED ===\n`);
  } finally {
    // 7. Cleanup
    if (sandbox) {
      console.log('7. Destroying sandbox...');
      await sandbox.destroy();
      console.log('   OK');
    }
    await provider.destroyAll();
  }
}

async function main(): Promise<void> {
  const providerName = typeof values.provider === 'string' ? values.provider : undefined;

  if (!providerName || providerName === 'docker') {
    // Test Docker provider
    const { DockerSandboxProvider } = await import('../src/providers/docker.js');
    const docker = new DockerSandboxProvider({ image: 'node:22-alpine' });
    await smokeTestProvider(docker);
  }

  if (!providerName || providerName === 'tangle') {
    // Test Tangle provider
    const { ensureOrchestrator, teardownOrchestrator } = await import('./setup.js') as typeof import('./setup.js');
    try {
      const config = await ensureOrchestrator();
      const { TangleSandboxProvider } = await import('../src/providers/tangle.js');
      const tangle = new TangleSandboxProvider({
        apiKey: config.apiKey,
        baseUrl: config.sdkUrl,
      });
      await smokeTestProvider(tangle);
    } finally {
      teardownOrchestrator();
    }
  }
}

main().catch((err) => {
  console.error('Smoke test failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
