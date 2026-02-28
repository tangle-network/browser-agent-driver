/**
 * TangleSandboxProvider — provisions sandboxes via the Tangle platform.
 *
 * Uses the public @tangle/sandbox SDK for container management, terminal
 * execution, and file I/O. The SDK is a peer dependency — only needed when
 * using this provider.
 */

import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type {
  Sandbox as AppSandbox,
  SandboxConfig,
  SandboxInfo,
  SandboxProvider,
  SandboxStatus,
  ExecOptions,
  ExecResult,
  FileEntry,
} from '../types.js';

const DEBUG = !!process.env.DEBUG_TANGLE;

function debug(msg: string, ...args: unknown[]): void {
  if (DEBUG) process.stderr.write(`[tangle] ${msg} ${args.map(String).join(' ')}\n`);
}

/** Escape a string for safe use inside single-quoted shell arguments. */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Strip terminal prompt noise injected by the sidecar PTY.
 *
 * The sidecar uses a PTY-based terminal that emits shell prompts and
 * internal control sequences around command output. These patterns:
 *  - Container prompt:  `abc123:/path# ...`  or  `user@host dir % ...`
 *  - CMD_DONE markers:  `printf '%s:%s\n' "__CMD_DONE_..."  "$?"`
 *  - Exit commands:     bare `exit` lines
 */
const PROMPT_PATTERNS = [
  // Container-style prompt: hex-id:/path# or hex-id:/path$
  /^[0-9a-f]{8,}:\/\S*[#$]\s/,
  // macOS-style prompt: user@Host dir %
  /^.+@\S+\s+\S+\s+%\s/,
  // CMD_DONE marker lines
  /__CMD_DONE_\d+__/,
  // printf used to emit CMD_DONE
  /^printf\s+'%s:%s\\n'/,
  // Bare exit command
  /^exit\s*$/,
];

function stripPromptNoise(output: string): string {
  return output
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true; // preserve blank lines
      return !PROMPT_PATTERNS.some((re) => re.test(trimmed));
    })
    .join('\n');
}

export interface TangleSandboxProviderOptions {
  /** Tangle sandbox API key (sk_sb_*) */
  apiKey: string;
  /** Sandbox API base URL (default: https://agents.tangle.network) */
  baseUrl?: string;
  /** Sandbox image preset (default: 'default') */
  image?: string;
  /** HTTP request timeout in ms (default: 300000) */
  timeoutMs?: number;
}

export class TangleSandboxProvider implements SandboxProvider {
  readonly name = 'tangle';
  private readonly apiKey: string;
  private readonly baseUrl?: string;
  private readonly image: string;
  private readonly timeoutMs: number;
  private readonly sandboxes = new Map<string, TangleSandbox>();
  private sdkClient: import('@tangle/sandbox').SandboxClient | undefined;

  constructor(options: TangleSandboxProviderOptions) {
    if (!options.apiKey) {
      throw new Error('TangleSandboxProvider requires an apiKey');
    }
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.image = options.image ?? 'default';
    this.timeoutMs = options.timeoutMs ?? 300_000;
  }

  private async getClient(): Promise<import('@tangle/sandbox').SandboxClient> {
    if (this.sdkClient) return this.sdkClient;
    try {
      const { Sandbox } = await import('@tangle/sandbox');
      this.sdkClient = new Sandbox({
        apiKey: this.apiKey,
        baseUrl: this.baseUrl,
        timeoutMs: this.timeoutMs,
      });
      return this.sdkClient;
    } catch {
      throw new Error(
        'TangleSandboxProvider requires @tangle/sandbox to be installed. ' +
        'Install it with: npm install @tangle/sandbox'
      );
    }
  }

  async provision(config: SandboxConfig): Promise<AppSandbox> {
    const client = await this.getClient();

    const createOptions: import('@tangle/sandbox').CreateSandboxOptions = {
      name: config.id ?? `sandbox-${randomUUID().slice(0, 8)}`,
      // Only send image if explicitly set (not 'default' sentinel) —
      // let orchestrator use its DEFAULT_CONTAINER_IMAGE
      ...(this.image !== 'default' ? { image: this.image } : {}),
    };

    if (config.env) {
      createOptions.env = config.env;
    }

    if (config.resources) {
      createOptions.resources = {
        cpuCores: config.resources.cpus,
        memoryMB: config.resources.memoryMb,
      };
      if (config.resources.timeoutMs) {
        createOptions.maxLifetimeSeconds = Math.ceil(config.resources.timeoutMs / 1000);
      }
    }

    if (config.providerConfig) {
      Object.assign(createOptions, config.providerConfig);
    }

    const instance = await client.create(createOptions);
    await instance.waitFor('running', { timeoutMs: this.timeoutMs });

    const sandbox = new TangleSandbox(instance, this.timeoutMs);
    this.sandboxes.set(instance.id, sandbox);
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

class TangleSandbox implements AppSandbox {
  readonly id: string;
  private _status: SandboxStatus = 'ready';
  private readonly instance: import('@tangle/sandbox').SandboxInstance;
  private readonly timeoutMs: number;

  get status(): SandboxStatus {
    return this._status;
  }

  constructor(instance: import('@tangle/sandbox').SandboxInstance, timeoutMs: number) {
    this.id = instance.id;
    this.instance = instance;
    this.timeoutMs = timeoutMs;
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    this._status = 'running';
    try {
      const result = await this.instance.exec(command, {
        cwd: options?.cwd,
        env: options?.env,
        timeoutMs: options?.timeoutMs ?? this.timeoutMs,
      });
      return {
        exitCode: result.exitCode,
        stdout: stripPromptNoise(result.stdout),
        stderr: stripPromptNoise(result.stderr),
      };
    } finally {
      if (this._status === 'running') {
        this._status = 'ready';
      }
    }
  }

  async *execStream(command: string, options?: ExecOptions): AsyncIterable<string> {
    this._status = 'running';
    try {
      // Try real streaming via process.spawn() + stdout() SSE
      if (this.instance.process) {
        try {
          const proc = await this.instance.process.spawn(command, {
            cwd: options?.cwd,
            env: options?.env,
            timeoutMs: options?.timeoutMs ?? this.timeoutMs,
          });

          let buffer = '';
          for await (const chunk of proc.stdout()) {
            // stdout() yields chunks that may contain partial lines
            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
              const cleaned = line.trim();
              if (cleaned && !PROMPT_PATTERNS.some((re) => re.test(cleaned))) {
                yield line;
              }
            }
          }
          // Flush remaining buffer
          if (buffer.trim()) {
            const cleaned = buffer.trim();
            if (!PROMPT_PATTERNS.some((re) => re.test(cleaned))) {
              yield buffer;
            }
          }

          const exitCode = await proc.wait();
          if (exitCode !== 0) {
            // Collect stderr for error reporting
            let stderr = '';
            try {
              const status = await proc.status();
              if ('stderr' in status) stderr = String(status.stderr);
            } catch { /* ignore */ }
            throw new Error(`Command failed (exit ${exitCode})${stderr ? ': ' + stderr : ''}`);
          }
          return;
        } catch (err) {
          // If process.spawn fails (e.g., endpoint not available), fall through to exec
          if (err instanceof Error && err.message.startsWith('Command failed')) throw err;
          debug('process.spawn() failed, falling back to exec:', err instanceof Error ? err.message : err);
        }
      }

      // Fallback: blocking exec() — yields lines after command completes
      const result = await this.instance.exec(command, {
        cwd: options?.cwd,
        env: options?.env,
        timeoutMs: options?.timeoutMs ?? this.timeoutMs,
      });

      const cleaned = stripPromptNoise(result.stdout);
      const lines = cleaned.split('\n');
      for (const line of lines) {
        if (line) yield line;
      }

      if (result.exitCode !== 0 && result.stderr) {
        throw new Error(`Command failed (exit ${result.exitCode}): ${stripPromptNoise(result.stderr)}`);
      }
    } finally {
      if (this._status === 'running') {
        this._status = 'ready';
      }
    }
  }

  async writeFile(path: string, content: string | Buffer): Promise<void> {
    const text = typeof content === 'string' ? content : content.toString('utf-8');

    // Try SDK write() first (works for workspace-relative paths)
    try {
      await this.instance.write(path, text);
      return;
    } catch (err) {
      debug('SDK write() failed, falling back to exec:', err instanceof Error ? err.message : err);
    }

    // Exec-based fallback — handles any filesystem path
    const b64 = Buffer.from(text).toString('base64');
    const escaped = shellEscape(path);
    const result = await this.instance.exec(
      `mkdir -p "$(dirname ${escaped})" && echo '${b64}' | base64 -d > ${escaped}`,
      { timeoutMs: this.timeoutMs },
    );
    if (result.exitCode !== 0) {
      throw new Error(`writeFile failed (exit ${result.exitCode}): ${result.stderr}`);
    }
  }

  async readFile(path: string): Promise<Buffer> {
    // Try SDK read() first (works for workspace-relative paths)
    try {
      const content = await this.instance.read(path);
      return Buffer.from(content);
    } catch (err) {
      debug('SDK read() failed, falling back to exec:', err instanceof Error ? err.message : err);
    }

    // Exec-based fallback — base64 encode for binary safety
    const result = await this.instance.exec(`base64 ${shellEscape(path)}`, {
      timeoutMs: this.timeoutMs,
    });
    if (result.exitCode !== 0) {
      throw new Error(`readFile failed (exit ${result.exitCode}): ${result.stderr}`);
    }
    return Buffer.from(stripPromptNoise(result.stdout).replace(/\s/g, ''), 'base64');
  }

  async listFiles(path: string): Promise<FileEntry[]> {
    // Try SDK fs.list() first
    try {
      const files = await this.instance.fs.list(path);
      return files.map((f) => ({
        name: f.path.split('/').pop() ?? f.path,
        path: f.path,
        isDirectory: f.isDir,
        size: f.size,
      }));
    } catch (err) {
      debug('SDK fs.list() failed, falling back to exec:', err instanceof Error ? err.message : err);
    }

    // Exec-based fallback using ls
    // For relative paths, resolve against $AGENT_WORKSPACE_ROOT since
    // the terminal CWD may differ from the workspace root
    let lsTarget: string;
    if (path === '.' || !path.startsWith('/')) {
      const suffix = path === '.' ? '' : `/${path}`;
      // Double quotes so $AGENT_WORKSPACE_ROOT expands
      lsTarget = `"\${AGENT_WORKSPACE_ROOT:-.}${suffix}"`;
    } else {
      lsTarget = shellEscape(path);
    }
    const result = await this.instance.exec(
      `ls -1apL ${lsTarget} 2>/dev/null`,
      { timeoutMs: this.timeoutMs },
    );
    if (result.exitCode !== 0) {
      throw new Error(`listFiles failed (exit ${result.exitCode}): ${result.stderr}`);
    }
    return stripPromptNoise(result.stdout)
      .split('\n')
      .filter((l) => l && l !== './' && l !== '../')
      .map((name) => {
        const isDir = name.endsWith('/');
        const cleanName = isDir ? name.slice(0, -1) : name;
        return {
          name: cleanName,
          path: path.endsWith('/') ? `${path}${cleanName}` : `${path}/${cleanName}`,
          isDirectory: isDir,
        };
      });
  }

  /** Copy an entire directory from sandbox to local filesystem */
  async copyDirectory(remotePath: string, localPath: string): Promise<void> {
    mkdirSync(localPath, { recursive: true });

    // Try SDK fs.downloadDir() first
    try {
      await this.instance.fs.downloadDir(remotePath, localPath);
      return;
    } catch (err) {
      debug('SDK fs.downloadDir() failed, falling back to exec:', err instanceof Error ? err.message : err);
    }

    // Exec-based fallback — tar + base64 for binary-safe transfer
    const escaped = shellEscape(remotePath);
    const result = await this.instance.exec(
      `tar czf - -C ${escaped} . 2>/dev/null | base64`,
      { timeoutMs: this.timeoutMs },
    );
    if (result.exitCode !== 0) {
      throw new Error(`copyDirectory failed (exit ${result.exitCode}): ${result.stderr}`);
    }

    // Decode and extract locally
    const tarBuffer = Buffer.from(
      stripPromptNoise(result.stdout).replace(/\s/g, ''),
      'base64',
    );
    const { writeFileSync, unlinkSync } = await import('node:fs');
    const { execFileSync } = await import('node:child_process');
    const tmpTar = `${localPath}/.tmp-archive-${Date.now()}.tar.gz`;
    writeFileSync(tmpTar, tarBuffer);
    try {
      execFileSync('tar', ['xzf', tmpTar, '-C', localPath]);
    } finally {
      try { unlinkSync(tmpTar); } catch { /* ignore */ }
    }
  }

  async destroy(): Promise<void> {
    this._status = 'destroyed';
    await this.instance.delete().catch(() => {});
  }
}
