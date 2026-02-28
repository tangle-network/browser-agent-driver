/**
 * DockerSandboxProvider — provisions sandboxes using local Docker CLI.
 *
 * Runs agent-driver inside Docker containers using the existing Dockerfile.
 * Zero SDK dependencies — uses child_process.spawn for all Docker interactions.
 */

import { spawn, execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type {
  Sandbox,
  SandboxConfig,
  SandboxInfo,
  SandboxProvider,
  SandboxStatus,
  ExecOptions,
  ExecResult,
  FileEntry,
} from '../types.js';

export interface DockerSandboxProviderOptions {
  /** Docker image to use (default: 'agent-driver') */
  image?: string;
  /** Extra docker run args (e.g., ['--gpus', 'all']) */
  dockerArgs?: string[];
}

export class DockerSandboxProvider implements SandboxProvider {
  readonly name = 'docker';
  private readonly image: string;
  private readonly dockerArgs: string[];
  private readonly sandboxes = new Map<string, DockerSandbox>();

  constructor(options?: DockerSandboxProviderOptions) {
    this.image = options?.image ?? 'agent-driver';
    this.dockerArgs = options?.dockerArgs ?? [];
  }

  async provision(config: SandboxConfig): Promise<Sandbox> {
    const id = config.id ?? `sandbox-${randomUUID().slice(0, 8)}`;

    const args = [
      'run', '-d',
      '--name', id,
    ];

    // Resource limits
    if (config.resources?.cpus) {
      args.push('--cpus', String(config.resources.cpus));
    }
    if (config.resources?.memoryMb) {
      args.push('--memory', `${config.resources.memoryMb}m`);
    }

    // Environment variables
    if (config.env) {
      for (const [key, value] of Object.entries(config.env)) {
        args.push('-e', `${key}=${value}`);
      }
    }

    // Extra user-supplied args
    args.push(...this.dockerArgs);

    // Override entrypoint so we can keep the container alive for exec
    args.push('--entrypoint', 'sleep');

    // Image + keep-alive command
    args.push(this.image, 'infinity');

    await dockerExec(args);

    const sandbox = new DockerSandbox(id);
    this.sandboxes.set(id, sandbox);
    return sandbox;
  }

  async list(): Promise<SandboxInfo[]> {
    const infos: SandboxInfo[] = [];
    for (const [id, sandbox] of this.sandboxes) {
      infos.push({ id, status: sandbox.status });
    }
    return infos;
  }

  async destroyAll(): Promise<void> {
    const destroys = [...this.sandboxes.values()].map((s) => s.destroy());
    await Promise.allSettled(destroys);
    this.sandboxes.clear();
  }
}

class DockerSandbox implements Sandbox {
  readonly id: string;
  private _status: SandboxStatus = 'ready';

  get status(): SandboxStatus {
    return this._status;
  }

  constructor(id: string) {
    this.id = id;
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    this._status = 'running';
    const args = buildExecArgs(this.id, command, options);

    try {
      const result = await dockerExec(args, options?.timeoutMs);
      return result;
    } finally {
      if (this._status === 'running') {
        this._status = 'ready';
      }
    }
  }

  async *execStream(command: string, options?: ExecOptions): AsyncIterable<string> {
    this._status = 'running';
    const args = buildExecArgs(this.id, command, options);

    try {
      yield* dockerExecStream(args, options?.timeoutMs);
    } finally {
      if (this._status === 'running') {
        this._status = 'ready';
      }
    }
  }

  async writeFile(path: string, content: string | Buffer): Promise<void> {
    const data = typeof content === 'string' ? content : content.toString('base64');
    const decode = typeof content === 'string'
      ? `cat > ${shellEscape(path)}`
      : `base64 -d > ${shellEscape(path)}`;

    // Ensure parent directory exists, then write content via stdin
    const mkdirCmd = `mkdir -p $(dirname ${shellEscape(path)})`;
    await dockerExec(['exec', this.id, 'sh', '-c', mkdirCmd]);

    await new Promise<void>((resolve, reject) => {
      const proc = spawn('docker', ['exec', '-i', this.id, 'sh', '-c', decode], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      proc.stdin.write(data);
      proc.stdin.end();

      let stderr = '';
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`writeFile failed (exit ${code}): ${stderr}`));
      });
      proc.on('error', reject);
    });
  }

  async readFile(path: string): Promise<Buffer> {
    // Use base64 encoding to safely transfer binary data (videos, images)
    // through the Docker exec pipe without UTF-8 corruption
    const result = await dockerExec([
      'exec', this.id, 'sh', '-c',
      `base64 ${shellEscape(path)}`,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`readFile failed (exit ${result.exitCode}): ${result.stderr}`);
    }
    return Buffer.from(result.stdout.replace(/\s/g, ''), 'base64');
  }

  /** Copy an entire directory from the container to the local filesystem */
  async copyDirectory(remotePath: string, localPath: string): Promise<void> {
    mkdirSync(localPath, { recursive: true });
    const result = await dockerExec(['cp', `${this.id}:${remotePath}/.`, `${localPath}/`]);
    if (result.exitCode !== 0) {
      throw new Error(`copyDirectory failed (exit ${result.exitCode}): ${result.stderr}`);
    }
  }

  async listFiles(path: string): Promise<FileEntry[]> {
    // Use ls -1F to get type indicators (/ for directories)
    const result = await dockerExec([
      'exec', this.id, 'sh', '-c',
      `ls -1pA ${shellEscape(path)} 2>/dev/null || true`,
    ]);

    if (!result.stdout.trim()) return [];

    return result.stdout.trim().split('\n').map((line) => {
      const isDirectory = line.endsWith('/');
      const name = isDirectory ? line.slice(0, -1) : line;
      return {
        name,
        path: path.endsWith('/') ? `${path}${name}` : `${path}/${name}`,
        isDirectory,
      };
    });
  }

  async destroy(): Promise<void> {
    this._status = 'destroyed';
    await dockerExec(['rm', '-f', this.id]).catch(() => {});
  }
}

// ============================================================================
// Docker CLI helpers
// ============================================================================

function buildExecArgs(containerId: string, command: string, options?: ExecOptions): string[] {
  const args = ['exec'];

  if (options?.cwd) {
    args.push('-w', options.cwd);
  }
  if (options?.env) {
    for (const [key, value] of Object.entries(options.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  args.push(containerId, 'sh', '-c', command);
  return args;
}

function dockerExec(args: string[], timeoutMs?: number): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const proc = execFile('docker', args, {
      maxBuffer: 50 * 1024 * 1024, // 50 MB
      timeout: timeoutMs,
    }, (error, stdout, stderr) => {
      if (error && !('code' in error)) {
        reject(error);
        return;
      }
      resolve({
        exitCode: proc.exitCode ?? (error ? 1 : 0),
        stdout: stdout ?? '',
        stderr: stderr ?? '',
      });
    });
  });
}

async function* dockerExecStream(args: string[], timeoutMs?: number): AsyncIterable<string> {
  const proc = spawn('docker', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs) {
    timer = setTimeout(() => {
      proc.kill('SIGTERM');
    }, timeoutMs);
  }

  try {
    let buffer = '';
    for await (const chunk of proc.stdout) {
      buffer += (chunk as Buffer).toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        yield line;
      }
    }
    if (buffer) {
      yield buffer;
    }
  } finally {
    if (timer) clearTimeout(timer);
    proc.kill();
  }
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
