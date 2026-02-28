/**
 * Artifact pipeline test — verifies that files (including binary data)
 * are correctly extracted from Docker containers via both:
 *   1. `copyDirectory` (docker cp — bulk, binary-safe)
 *   2. `readFile` (base64 roundtrip — single file)
 *
 * Usage:
 *   npx tsx tests/test-artifacts.ts
 */

import { mkdirSync, readFileSync, rmSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DockerSandboxProvider } from '../src/providers/docker.js';
import type { Sandbox } from '../src/types.js';

const OUTPUT_DIR = join(import.meta.dirname, '../test-artifact-output');

async function testArtifactPipeline(): Promise<void> {
  console.log('\n=== Artifact Pipeline Test ===\n');

  // Clean up previous test output
  rmSync(OUTPUT_DIR, { recursive: true, force: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const provider = new DockerSandboxProvider({ image: 'node:22-alpine' });
  let sandbox: Sandbox | undefined;

  try {
    // 1. Provision a container
    console.log('1. Provisioning sandbox...');
    sandbox = await provider.provision({ id: 'artifact-test' });
    console.log(`   OK: ${sandbox.id}`);

    // 2. Create test files inside the container: text, JSON, and binary
    console.log('2. Creating test files in container...');

    // Create a directory structure mimicking agent-driver output
    await sandbox.exec('mkdir -p /output/test-1 /output/test-2 /output/suite');

    // Text file
    await sandbox.exec('echo \'{"passed": true}\' > /output/suite/report.json');

    // JSON manifest
    const manifest = [
      { testId: 'test-1', type: 'screenshot', name: 'screenshot.png', uri: 'file:///output/test-1/screenshot.png', contentType: 'image/png', sizeBytes: 0 },
      { testId: 'test-1', type: 'report-json', name: 'report.json', uri: 'file:///output/suite/report.json', contentType: 'application/json', sizeBytes: 0 },
      { testId: 'test-2', type: 'video', name: 'recording.webm', uri: 'file:///output/test-2/recording.webm', contentType: 'video/webm', sizeBytes: 0 },
    ];
    await sandbox.exec(`cat > /output/suite/manifest.json << 'JSONEOF'
${JSON.stringify(manifest, null, 2)}
JSONEOF`);

    // Binary file: 1KB of random bytes (simulates screenshot)
    await sandbox.exec('dd if=/dev/urandom of=/output/test-1/screenshot.png bs=1024 count=1 2>/dev/null');

    // Larger binary file: 10KB of random bytes (simulates video)
    await sandbox.exec('dd if=/dev/urandom of=/output/test-2/recording.webm bs=1024 count=10 2>/dev/null');

    // Get the md5sums of files inside the container for comparison
    const md5Result = await sandbox.exec('md5sum /output/test-1/screenshot.png /output/test-2/recording.webm /output/suite/report.json');
    console.log('   Container md5sums:');
    for (const line of md5Result.stdout.trim().split('\n')) {
      console.log(`     ${line}`);
    }

    // 3. Test readFile with binary data (base64 roundtrip)
    console.log('\n3. Testing readFile (base64 roundtrip) for binary data...');
    const screenshotBuffer = await sandbox.readFile('/output/test-1/screenshot.png');
    console.log(`   screenshot.png: ${screenshotBuffer.length} bytes`);
    if (screenshotBuffer.length !== 1024) {
      throw new Error(`Expected 1024 bytes, got ${screenshotBuffer.length}`);
    }
    console.log('   OK: binary data read correctly via base64');

    // 4. Test copyDirectory (docker cp)
    console.log('\n4. Testing copyDirectory (docker cp)...');
    const copyDir = join(OUTPUT_DIR, 'bulk-copy');
    await sandbox.copyDirectory!('/output', copyDir);

    // Verify directory structure was preserved
    const expectedFiles = [
      'test-1/screenshot.png',
      'test-2/recording.webm',
      'suite/manifest.json',
      'suite/report.json',
    ];

    for (const relPath of expectedFiles) {
      const fullPath = join(copyDir, relPath);
      try {
        const stat = statSync(fullPath);
        console.log(`   ${relPath}: ${stat.size} bytes ✓`);
      } catch {
        throw new Error(`Expected file not found: ${relPath}`);
      }
    }

    // Verify binary integrity: screenshot should be exactly 1024 bytes
    const localScreenshot = readFileSync(join(copyDir, 'test-1/screenshot.png'));
    if (localScreenshot.length !== 1024) {
      throw new Error(`Binary integrity check failed: expected 1024 bytes, got ${localScreenshot.length}`);
    }
    console.log('   Binary integrity check: OK (1024 bytes match)');

    // Verify video: 10KB
    const localVideo = readFileSync(join(copyDir, 'test-2/recording.webm'));
    if (localVideo.length !== 10240) {
      throw new Error(`Video integrity check failed: expected 10240 bytes, got ${localVideo.length}`);
    }
    console.log('   Video integrity check: OK (10240 bytes match)');

    // 5. Verify readFile matches copyDirectory for the same file
    console.log('\n5. Comparing readFile vs copyDirectory output...');
    if (Buffer.compare(screenshotBuffer, localScreenshot) !== 0) {
      throw new Error('readFile and copyDirectory returned different data!');
    }
    console.log('   readFile matches copyDirectory: OK');

    // 6. List what we got
    console.log('\n6. Collected artifacts:');
    listDirRecursive(copyDir, '   ');

    console.log('\n=== Artifact Pipeline: ALL PASSED ===\n');
  } finally {
    if (sandbox) {
      console.log('Cleaning up sandbox...');
      await sandbox.destroy();
    }
    await provider.destroyAll();
    // Clean up test output
    rmSync(OUTPUT_DIR, { recursive: true, force: true });
  }
}

function listDirRecursive(dir: string, indent: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      console.log(`${indent}${entry.name}/`);
      listDirRecursive(join(dir, entry.name), indent + '  ');
    } else {
      const stat = statSync(join(dir, entry.name));
      console.log(`${indent}${entry.name} (${stat.size} bytes)`);
    }
  }
}

testArtifactPipeline().catch((err) => {
  console.error('Artifact pipeline test failed:', err);
  process.exit(1);
});
