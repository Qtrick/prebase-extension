import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import type {
  EngineRequest,
  EngineResponse,
  GetNetworkGraphResult,
  InitializeResult,
  TemporalCompareResult,
  TemporalIndexResult,
  TemporalSnapshotResult,
  TemporalTimelineEntry,
} from '../../../shared/protocol/src/index';
import { PROTOCOL_VERSION, isCanonicalGraph } from '../../../shared/protocol/src/index';
import { validateEngineLine } from '../protocol/validate';

export type EngineLogFn = (message: string) => void;

export class EngineClientError extends Error {
  constructor(
    message: string,
    readonly category:
      | 'engine_not_ready'
      | 'analysis_unavailable'
      | 'timeout'
      | 'internal'
      | 'invalid_request' = 'internal',
  ) {
    super(message);
    this.name = 'EngineClientError';
  }
}

interface Pending {
  resolve: (value: EngineResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Manages the Rust prebase-engine subprocess over JSON-lines stdio.
 */
export class EngineClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, Pending>();
  private nextId = 1;
  private ready = false;
  private disposed = false;
  private stderrBuffer = '';
  private stdoutReader: ReadlineInterface | null = null;
  /** Serializes start() so concurrent callers share one spawn. */
  private startInFlight: Promise<InitializeResult> | null = null;

  constructor(
    private readonly extensionPath: string,
    private readonly log: EngineLogFn,
    private readonly defaultTimeoutMs = 15_000,
  ) {}

  get isReady(): boolean {
    return this.ready && this.process !== null && !this.disposed;
  }

  resolveBinaryPath(): string {
    const name = process.platform === 'win32' ? 'prebase-engine.exe' : 'prebase-engine';
    // Prefer the packaged binary. Dev fallbacks exist only for Extension Development Host.
    const candidates = [
      join(this.extensionPath, 'bin', name),
      join(this.extensionPath, '..', 'target', 'release', name),
      join(this.extensionPath, '..', 'target', 'debug', name),
    ];
    for (const path of candidates) {
      if (!existsSync(path)) continue;
      if (process.platform !== 'win32') {
        try {
          accessSync(path, constants.X_OK);
        } catch {
          throw new EngineClientError(
            `PreBase engine binary is not executable: ${path}`,
            'analysis_unavailable',
          );
        }
      }
      return path;
    }
    throw new EngineClientError(
      `PreBase engine binary not found. Build with "npm run build:engine". Looked in: ${candidates.join(', ')}`,
      'analysis_unavailable',
    );
  }

  async start(): Promise<InitializeResult> {
    if (this.disposed) {
      throw new EngineClientError('Engine client disposed', 'engine_not_ready');
    }
    if (this.startInFlight) {
      return this.startInFlight;
    }
    this.startInFlight = this.doStart().finally(() => {
      this.startInFlight = null;
    });
    return this.startInFlight;
  }

  private async doStart(): Promise<InitializeResult> {
    if (this.disposed) {
      throw new EngineClientError('Engine client disposed', 'engine_not_ready');
    }
    if (this.process) {
      await this.shutdown();
    }
    if (this.disposed) {
      throw new EngineClientError('Engine client disposed', 'engine_not_ready');
    }

    const binary = this.resolveBinaryPath();
    this.log(`Starting engine: ${binary}`);

    const child = spawn(binary, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.process = child;
    this.ready = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    this.closeStdoutReader();
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.stdoutReader = rl;
    rl.on('line', (line) => this.onLine(line));

    child.stderr.on('data', (chunk: string) => {
      this.stderrBuffer += chunk;
      const lines = this.stderrBuffer.split('\n');
      this.stderrBuffer = lines.pop() ?? '';
      for (const part of lines) {
        const trimmed = part.trim();
        if (trimmed) this.log(`[engine:stderr] ${trimmed}`);
      }
    });

    child.on('exit', (code, signal) => {
      // Ignore exits from a superseded child after restart/shutdown cleared this.process.
      if (this.process !== child) {
        return;
      }
      this.log(`Engine exited code=${code} signal=${signal}`);
      this.closeStdoutReader();
      this.ready = false;
      this.process = null;
      this.failAllPending(
        new EngineClientError('Engine process exited unexpectedly', 'engine_not_ready'),
      );
    });

    child.on('error', (err) => {
      if (this.process !== child) {
        return;
      }
      this.log(`Engine spawn error: ${err.message}`);
      this.ready = false;
      this.failAllPending(
        new EngineClientError(`Failed to start engine: ${err.message}`, 'analysis_unavailable'),
      );
    });

    const init = await this.request<InitializeResult>('initialize', {});
    if (this.disposed || this.process !== child) {
      throw new EngineClientError('Engine client disposed', 'engine_not_ready');
    }
    this.ready = true;
    this.log(`Engine ready v${init.engineVersion}`);
    return init;
  }

  async getNetworkGraph(
    workspacePath: string,
    options: {
      preferFixture?: boolean;
      forceRefresh?: boolean;
      timeoutMs?: number;
    } = {},
  ): Promise<GetNetworkGraphResult> {
    if (!this.isReady) {
      throw new EngineClientError('Engine is not ready', 'engine_not_ready');
    }
    const result = await this.request<GetNetworkGraphResult>(
      'getNetworkGraph',
      {
        workspacePath,
        preferFixture: options.preferFixture === true,
        forceRefresh: options.forceRefresh === true,
      },
      options.timeoutMs ?? 60_000,
    );
    if (!result?.graph || !isCanonicalGraph(result.graph)) {
      throw new EngineClientError('Engine returned invalid graph payload', 'internal');
    }
    return result;
  }

  async listTemporalHistory(
    workspacePath: string,
    storagePath: string,
    limit?: number,
  ): Promise<{ timeline: TemporalTimelineEntry[]; isShallow: boolean; note?: string }> {
    if (!this.isReady) {
      throw new EngineClientError('Engine is not ready', 'engine_not_ready');
    }
    return this.request('listTemporalHistory', {
      workspacePath,
      storagePath,
      limit,
    }, 30_000);
  }

  async indexTemporalHistory(
    workspacePath: string,
    storagePath: string,
    limit?: number,
  ): Promise<TemporalIndexResult> {
    if (!this.isReady) {
      throw new EngineClientError('Engine is not ready', 'engine_not_ready');
    }
    return this.request(
      'indexTemporalHistory',
      { workspacePath, storagePath, limit },
      300_000,
    );
  }

  async getTemporalSnapshot(
    workspacePath: string,
    storagePath: string,
    commitOid: string,
  ): Promise<TemporalSnapshotResult> {
    if (!this.isReady) {
      throw new EngineClientError('Engine is not ready', 'engine_not_ready');
    }
    const result = await this.request<TemporalSnapshotResult>(
      'getTemporalSnapshot',
      { workspacePath, storagePath, commitOid },
      120_000,
    );
    if (!result?.graph || !isCanonicalGraph(result.graph)) {
      throw new EngineClientError('Invalid temporal snapshot', 'internal');
    }
    return result;
  }

  async compareTemporalSnapshots(
    storagePath: string,
    baseCommitOid: string,
    targetCommitOid: string,
  ): Promise<TemporalCompareResult> {
    if (!this.isReady) {
      throw new EngineClientError('Engine is not ready', 'engine_not_ready');
    }
    return this.request(
      'compareTemporalSnapshots',
      { storagePath, baseCommitOid, targetCommitOid },
      60_000,
    );
  }

  async shutdown(): Promise<void> {
    if (!this.process) {
      this.ready = false;
      return;
    }
    try {
      await this.request('shutdown', {}, 3_000);
    } catch {
      // ignore; we will kill the process
    }
    const child = this.process;
    this.process = null;
    this.ready = false;
    this.closeStdoutReader();
    this.failAllPending(new EngineClientError('Engine shutting down', 'engine_not_ready'));
    if (child && !child.killed) {
      child.kill();
    }
  }

  dispose(): void {
    this.disposed = true;
    void this.shutdown();
  }

  private request<T>(method: string, params: unknown, timeoutMs = this.defaultTimeoutMs): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.process || !this.process.stdin.writable) {
        reject(new EngineClientError('Engine process is not running', 'engine_not_ready'));
        return;
      }
      const id = String(this.nextId++);
      const payload: EngineRequest = {
        protocolVersion: PROTOCOL_VERSION,
        id,
        method,
        params,
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new EngineClientError(`Request ${method} timed out`, 'timeout'));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (resp) => {
          if (resp.error) {
            reject(
              new EngineClientError(
                resp.error.message,
                mapCategory(resp.error.category),
              ),
            );
            return;
          }
          resolve(resp.result as T);
        },
        reject,
        timer,
      });

      try {
        this.process.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          new EngineClientError(
            `Failed to write to engine: ${err instanceof Error ? err.message : String(err)}`,
            'internal',
          ),
        );
      }
    });
  }

  private onLine(line: string): void {
    const resp = validateEngineLine(line);
    if (!resp) {
      this.log(`Ignoring malformed engine line: ${line.slice(0, 200)}`);
      return;
    }
    const pending = this.pending.get(resp.id);
    if (!pending) {
      this.log(`No pending request for id=${resp.id}`);
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(resp.id);
    pending.resolve(resp);
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private closeStdoutReader(): void {
    if (!this.stdoutReader) return;
    this.stdoutReader.close();
    this.stdoutReader = null;
  }
}

function mapCategory(
  category: string,
): 'engine_not_ready' | 'analysis_unavailable' | 'timeout' | 'internal' | 'invalid_request' {
  switch (category) {
    case 'engine_not_ready':
    case 'analysis_unavailable':
    case 'timeout':
    case 'invalid_request':
      return category;
    default:
      return 'internal';
  }
}
