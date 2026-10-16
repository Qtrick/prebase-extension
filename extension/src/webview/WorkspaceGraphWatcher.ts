import * as vscode from 'vscode';

export type WatchReason = 'create' | 'change' | 'delete';

export interface WorkspaceGraphWatcherOptions {
  folder: vscode.WorkspaceFolder;
  /** Debounce window for coalescing bursty FS events. */
  debounceMs?: number;
  onDebouncedChange: (uris: vscode.Uri[], reasons: Set<WatchReason>) => void;
  log?: (message: string) => void;
}

/**
 * VS Code owns file watching. Events are hints; the engine re-discovers and
 * content-hashes on each refresh. Dispose with the panel.
 *
 * ponytail: single RelativePattern watcher + debounce; full rescan on fire
 * (parse cache in Rust skips unchanged files). No second Rust notify watcher.
 */
export class WorkspaceGraphWatcher implements vscode.Disposable {
  private readonly watcher: vscode.FileSystemWatcher;
  private readonly disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;
  private pending = new Map<string, vscode.Uri>();
  private reasons = new Set<WatchReason>();
  private disposed = false;
  private readonly debounceMs: number;
  private readonly onDebouncedChange: WorkspaceGraphWatcherOptions['onDebouncedChange'];
  private readonly log: (message: string) => void;

  constructor(options: WorkspaceGraphWatcherOptions) {
    this.debounceMs = options.debounceMs ?? 400;
    this.onDebouncedChange = options.onDebouncedChange;
    this.log = options.log ?? (() => undefined);

    // Supported source extensions + common resolution config files.
    const pattern = new vscode.RelativePattern(
      options.folder,
      '**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts,rs,json}',
    );
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.disposables.push(this.watcher);

    this.disposables.push(
      this.watcher.onDidCreate((uri) => this.enqueue(uri, 'create')),
      this.watcher.onDidChange((uri) => this.enqueue(uri, 'change')),
      this.watcher.onDidDelete((uri) => this.enqueue(uri, 'delete')),
    );
  }

  private enqueue(uri: vscode.Uri, reason: WatchReason): void {
    if (this.disposed) return;
    if (!isAnalyzableHint(uri)) return;
    this.pending.set(uri.fsPath, uri);
    this.reasons.add(reason);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  private flush(): void {
    this.timer = undefined;
    if (this.disposed || this.pending.size === 0) return;
    const uris = [...this.pending.values()];
    const reasons = new Set(this.reasons);
    this.pending.clear();
    this.reasons.clear();
    this.log(
      `Workspace change coalesced: ${uris.length} path(s) [${[...reasons].join(',')}]`,
    );
    this.onDebouncedChange(uris, reasons);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
    this.reasons.clear();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}

function isAnalyzableHint(uri: vscode.Uri): boolean {
  const path = uri.fsPath.replace(/\\/g, '/').toLowerCase();
  // Defensive: never react to dependency / build trees even if exclude lags.
  const blocked = [
    '/node_modules/',
    '/.git/',
    '/target/',
    '/dist/',
    '/out/',
    '/.next/',
    '/build/',
  ];
  if (blocked.some((b) => path.includes(b))) return false;
  return true;
}
