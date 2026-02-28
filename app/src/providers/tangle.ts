/**
 * TangleSandboxProvider — provisions sandboxes via the Tangle platform.
 *
 * Uses @tangle/sandbox SDK for container management, terminal execution,
 * and file I/O. The SDK is a peer dependency — only needed when using
 * this provider.
 */

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

export interface TangleSandboxProviderOptions {
  /** Tangle sandbox API key */
  apiKey?: string;
  /** Orchestrator base URL */
  baseUrl?: string;
  /** Sandbox image preset (default: 'default') */
  image?: string;
  /** HTTP request timeout in ms (default: 300000 for local dev with sidecar startup) */
  timeoutMs?: number;
}

/** Lazily-resolved @tangle/sandbox types */
interface TangleSandboxSDK {
  Sandbox: new (config: { apiKey: string; baseUrl?: string; timeoutMs?: number }) => TangleSandboxClient;
}

interface TangleSandboxClient {
  create(options: Record<string, unknown>): Promise<TangleSandboxInstance>;
}

interface TangleSandboxInstance {
  id: string;
  status: string;
  connection: { sidecarUrl: string; authToken: string } | undefined;
  exec(command: string, options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  fs: {
    list(path: string, options?: { all?: boolean; long?: boolean }): Promise<TangleFileInfo[]>;
  };
  refresh(): Promise<void>;
  waitFor(
    status: string | string[],
    options?: { timeoutMs?: number; pollIntervalMs?: number },
  ): Promise<void>;
  stop(): Promise<void>;
  delete(): Promise<void>;
}

interface TangleFileInfo {
  name: string;
  path: string;
  isDir: boolean;
  isFile: boolean;
  size: number;
}

export class TangleSandboxProvider implements SandboxProvider {
  readonly name = 'tangle';
  private readonly apiKey: string;
  private readonly baseUrl?: string;
  private readonly image: string;
  private readonly timeoutMs: number;
  private readonly sandboxes = new Map<string, TangleSandbox>();
  private sdkModule: TangleSandboxSDK | undefined;

  constructor(options: TangleSandboxProviderOptions) {
    if (!options.apiKey) {
      throw new Error('TangleSandboxProvider requires an apiKey');
    }
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.image = options.image ?? 'default';
    this.timeoutMs = options.timeoutMs ?? 300_000; // 5 min for local dev sidecar startup
  }

  private async getSDK(): Promise<TangleSandboxSDK> {
    if (this.sdkModule) return this.sdkModule;
    try {
      // Dynamic import — @tangle/sandbox is an optional peer dependency
      this.sdkModule = await import('@tangle/sandbox') as unknown as TangleSandboxSDK;
      return this.sdkModule;
    } catch {
      throw new Error(
        'TangleSandboxProvider requires @tangle/sandbox to be installed. ' +
        'Install it with: npm install @tangle/sandbox'
      );
    }
  }

  async provision(config: SandboxConfig): Promise<Sandbox> {
    const sdk = await this.getSDK();
    const client = new sdk.Sandbox({
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      timeoutMs: this.timeoutMs,
    });

    const createOptions: Record<string, unknown> = {
      name: config.id ?? `sandbox-${randomUUID().slice(0, 8)}`,
      image: this.image,
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

    // Merge provider-specific config
    if (config.providerConfig) {
      Object.assign(createOptions, config.providerConfig);
    }

    const instance = await client.create(createOptions);
    await instance.waitFor('running', { timeoutMs: this.timeoutMs });

    const sandbox = new TangleSandbox(instance);
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

class TangleSandbox implements Sandbox {
  readonly id: string;
  private _status: SandboxStatus = 'ready';
  private readonly instance: TangleSandboxInstance;

  get status(): SandboxStatus {
    return this._status;
  }

  constructor(instance: TangleSandboxInstance) {
    this.id = instance.id;
    this.instance = instance;
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    this._status = 'running';
    try {
      const result = await this.instance.exec(command, {
        cwd: options?.cwd,
        env: options?.env,
        timeoutMs: options?.timeoutMs,
      });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
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
      // Use exec and split output into lines.
      // The SDK's process.spawn API could be used for true streaming,
      // but exec is simpler and sufficient for JSON-lines output.
      const result = await this.instance.exec(command, {
        cwd: options?.cwd,
        env: options?.env,
        timeoutMs: options?.timeoutMs,
      });

      const lines = result.stdout.split('\n');
      for (const line of lines) {
        if (line) yield line;
      }

      if (result.exitCode !== 0 && result.stderr) {
        throw new Error(`Command failed (exit ${result.exitCode}): ${result.stderr}`);
      }
    } finally {
      if (this._status === 'running') {
        this._status = 'ready';
      }
    }
  }

  async writeFile(path: string, content: string | Buffer): Promise<void> {
    const text = typeof content === 'string' ? content : content.toString('utf-8');
    await this.instance.write(path, text);
  }

  async readFile(path: string): Promise<Buffer> {
    const content = await this.instance.read(path);
    return Buffer.from(content);
  }

  async listFiles(path: string): Promise<FileEntry[]> {
    const files = await this.instance.fs.list(path, { all: true });
    return files.map((f) => ({
      name: f.name,
      path: f.path,
      isDirectory: f.isDir,
      size: f.size,
    }));
  }

  async destroy(): Promise<void> {
    this._status = 'destroyed';
    await this.instance.delete().catch(() => {});
  }
}
