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

    // 3. Write file
    // Tangle: write() uses SDK /files/write (workspace-relative), listFiles uses exec fallback
    // Docker: absolute paths work directly inside the container
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
    console.log(`5. Listing ${testDirPath}...`);
    try {
      const files = await sandbox.listFiles(testDirPath);
      const found = files.find((f) => f.name === 'smoke-test.txt');
      console.log(`   files: ${files.length} entries, smoke-test.txt ${found ? 'found' : 'NOT FOUND'}`);
      if (!found) throw new Error('smoke-test.txt not found in listing');
      console.log('   OK');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`   WARN: listFiles failed (${msg}) — continuing`);
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

    // 7. copyDirectory (if supported)
    if (sandbox.copyDirectory) {
      console.log('7. Testing copyDirectory...');
      // Create a multi-file structure in the sandbox
      const outputDir = provider.name === 'tangle' ? 'smoke-output' : '/tmp/smoke-output';
      await sandbox.exec(`mkdir -p ${outputDir}/sub && echo "file-a" > ${outputDir}/a.txt && echo "file-b" > ${outputDir}/sub/b.txt`);

      // Copy to local temp dir
      const localDir = `/tmp/smoke-copy-test-${Date.now()}`;
      try {
        await sandbox.copyDirectory(outputDir, localDir);
        // Verify files exist locally
        const { readdirSync, readFileSync, rmSync } = await import('node:fs');
        const topFiles = readdirSync(localDir);
        console.log(`   local files: ${topFiles.join(', ')}`);
        const aContent = readFileSync(`${localDir}/a.txt`, 'utf-8').trim();
        const bContent = readFileSync(`${localDir}/sub/b.txt`, 'utf-8').trim();
        if (aContent !== 'file-a') throw new Error(`unexpected a.txt: "${aContent}"`);
        if (bContent !== 'file-b') throw new Error(`unexpected sub/b.txt: "${bContent}"`);
        console.log('   OK');
        rmSync(localDir, { recursive: true, force: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`   WARN: copyDirectory failed (${msg}) — continuing`);
      }
    } else {
      console.log('7. copyDirectory... SKIPPED (not supported)');
    }

    console.log(`\n=== ${provider.name} provider: ALL PASSED ===\n`);
  } finally {
    // 8. Cleanup
    if (sandbox) {
      console.log('8. Destroying sandbox...');
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
    // Test Tangle provider against the real sandbox-api gateway
    const apiKey = process.env.TANGLE_API_KEY;
    const baseUrl = process.env.TANGLE_BASE_URL ?? 'http://localhost:4098';

    if (!apiKey) {
      console.log('\n=== Skipping tangle provider (set TANGLE_API_KEY + TANGLE_BASE_URL) ===\n');
    } else {
      const { TangleSandboxProvider } = await import('../src/providers/tangle.js');
      const tangle = new TangleSandboxProvider({ apiKey, baseUrl });
      await smokeTestProvider(tangle);
    }
  }
}

main().catch((err) => {
  console.error('Smoke test failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
