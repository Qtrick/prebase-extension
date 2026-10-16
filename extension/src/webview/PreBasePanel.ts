import { createHash, randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type {
  HostStatus,
  HostToWebview,
  WebviewToHost,
} from '../../../shared/protocol/src/index';
import { EngineClient, EngineClientError } from '../engine/EngineClient';
import { validateWebviewMessage } from '../protocol/validate';
import { isActiveRequest } from './requestSeq';
import { WorkspaceGraphWatcher } from './WorkspaceGraphWatcher';

/**
 * MVP workspace policy: use the first workspace folder.
 * Multi-root selection is deferred to a later prompt.
 */
export function resolveWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  return folders[0];
}

export class PreBasePanel {
  public static current: PreBasePanel | undefined;
  public static readonly viewType = 'prebase.graph';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly storageUri: vscode.Uri;
  private readonly output: vscode.OutputChannel;
  private engine: EngineClient;
  private disposables: vscode.Disposable[] = [];
  private graphRequestSeq = 0;
  private temporalRequestSeq = 0;
  private publishedRevision: string | undefined;
  private bootstrapPromise: Promise<void> | undefined;
  private disposed = false;
  private watcher: WorkspaceGraphWatcher | undefined;
  private folderChangeSub: vscode.Disposable | undefined;

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    storageUri: vscode.Uri,
    output: vscode.OutputChannel,
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.storageUri = storageUri;
    this.output = output;
    this.engine = new EngineClient(extensionUri.fsPath, (m) => this.output.appendLine(m));

    this.panel.webview.html = this.getHtml(this.panel.webview);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (raw) => void this.onMessage(raw),
      null,
      this.disposables,
    );

    this.folderChangeSub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      this.teardownWatcher();
      void this.loadGraph({ reason: 'workspace_folders', forceRefresh: true });
      this.setupWatcher();
    });
  }

  static createOrShow(
    extensionUri: vscode.Uri,
    storageUri: vscode.Uri,
    output: vscode.OutputChannel,
  ): PreBasePanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (PreBasePanel.current) {
      PreBasePanel.current.panel.reveal(column);
      return PreBasePanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      PreBasePanel.viewType,
      'PreBase',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      },
    );

    PreBasePanel.current = new PreBasePanel(panel, extensionUri, storageUri, output);
    return PreBasePanel.current;
  }

  static revive(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    storageUri: vscode.Uri,
    output: vscode.OutputChannel,
  ): void {
    if (PreBasePanel.current && PreBasePanel.current.panel !== panel) {
      PreBasePanel.current.dispose();
    }
    // Restored panels must re-apply resource roots before HTML is set.
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
    };
    PreBasePanel.current = new PreBasePanel(panel, extensionUri, storageUri, output);
  }

  private temporalStoragePath(workspaceFsPath: string): string {
    const scope = createHash('sha256').update(workspaceFsPath).digest('hex').slice(0, 16);
    return vscode.Uri.joinPath(this.storageUri, 'temporal', scope).fsPath;
  }

  private async onMessage(raw: unknown): Promise<void> {
    const msg = validateWebviewMessage(raw);
    if (!msg) {
      const preview = JSON.stringify(raw);
      this.output.appendLine(
        `Rejected invalid webview message: ${preview.slice(0, 200)}${preview.length > 200 ? '…' : ''}`,
      );
      return;
    }
    switch (msg.type) {
      case 'ready':
        await this.bootstrap();
        break;
      case 'requestGraph':
        await this.loadGraph({ reason: 'manual', forceRefresh: true });
        break;
      case 'retry':
        await this.loadGraph({ reason: 'retry', forceRefresh: true });
        break;
      case 'selectNode':
        this.post({ type: 'ack', intent: 'selectNode' });
        break;
      case 'setView':
        this.post({ type: 'ack', intent: `setView:${msg.view}` });
        if (msg.view === 'temporal') {
          await this.loadTemporalTimeline();
        }
        break;
      case 'temporalIndex':
        await this.indexTemporal(msg.limit);
        break;
      case 'temporalSelect':
        await this.loadTemporalSnapshot(msg.commitOid);
        break;
      case 'temporalCompare':
        await this.compareTemporal(msg.baseCommitOid, msg.targetCommitOid);
        break;
    }
  }

  private async bootstrap(): Promise<void> {
    if (this.bootstrapPromise) {
      return this.bootstrapPromise;
    }
    this.bootstrapPromise = this.runBootstrap().finally(() => {
      this.bootstrapPromise = undefined;
    });
    return this.bootstrapPromise;
  }

  private async runBootstrap(): Promise<void> {
    const folder = resolveWorkspaceFolder();
    if (!folder) {
      this.postStatus(
        'no_workspace',
        'Open a folder or workspace to use PreBase.',
      );
      return;
    }

    if (folder.uri.scheme !== 'file') {
      this.postStatus(
        'analysis_unavailable',
        'PreBase needs a local folder on disk. Virtual or remote-only workspaces are not supported in this MVP.',
        folder.name,
      );
      return;
    }

    this.postStatus(
      'engine_starting',
      'Starting analysis engine…',
      folder.name,
      folder.uri.fsPath,
    );

    try {
      await this.engine.start();
      this.postStatus(
        'engine_ready',
        'Engine ready. Loading graph…',
        folder.name,
        folder.uri.fsPath,
      );
      await this.loadGraph({ reason: 'bootstrap' });
      this.setupWatcher();
    } catch (err) {
      this.handleEngineError(err);
    }
  }

  private setupWatcher(): void {
    this.teardownWatcher();
    const folder = resolveWorkspaceFolder();
    if (!folder || this.disposed) return;

    this.watcher = new WorkspaceGraphWatcher({
      folder,
      debounceMs: 400,
      log: (m) => this.output.appendLine(m),
      onDebouncedChange: () => {
        void this.loadGraph({ reason: 'fs_watch', quiet: true });
      },
    });
  }

  private teardownWatcher(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
  }

  private async loadGraph(options: {
    reason: string;
    forceRefresh?: boolean;
    quiet?: boolean;
  }): Promise<void> {
    const folder = resolveWorkspaceFolder();
    if (!folder) {
      this.postStatus('no_workspace', 'Open a folder or workspace to use PreBase.');
      return;
    }

    const seq = ++this.graphRequestSeq;
    const status: HostStatus = options.quiet ? 'updating_graph' : 'loading_graph';
    const message = options.quiet
      ? 'Updating network graph…'
      : options.forceRefresh
        ? 'Rebuilding network graph…'
        : 'Loading network graph…';

    this.postStatus(status, message, folder.name, folder.uri.fsPath);

    try {
      if (!this.engine.isReady) {
        this.postStatus('retrying', 'Restarting engine…', folder.name, folder.uri.fsPath);
        await this.engine.start();
      }
      const { graph } = await this.engine.getNetworkGraph(folder.uri.fsPath, {
        preferFixture: false,
        forceRefresh: options.forceRefresh === true,
        timeoutMs: 90_000,
      });
      if (!isActiveRequest(seq, this.graphRequestSeq, this.disposed)) return;

      if (
        this.publishedRevision &&
        graph.revision === this.publishedRevision &&
        options.quiet
      ) {
        this.postStatus(
          'graph_ready',
          `Network graph up to date: ${graph.nodes.length} files, ${graph.edges.length} imports.`,
          folder.name,
          folder.uri.fsPath,
        );
        return;
      }

      this.publishedRevision = graph.revision;

      const readyStatus: HostStatus =
        graph.nodes.length === 0 ? 'empty_graph' : 'graph_ready';
      const cov = graph.coverage;
      const readyMessage =
        graph.nodes.length === 0
          ? 'No supported source files produced graph nodes.'
          : graph.provenance === 'fixture'
            ? 'Network graph ready (sample data).'
            : cov
              ? `Network graph ready: ${graph.nodes.length} files, ${graph.edges.length} imports (${cov.resolvedImports} resolved, ${cov.unresolvedImports} unresolved) in ${cov.durationMs}ms.`
              : 'Network graph ready.';

      this.post({
        type: 'graph',
        graph,
        status: readyStatus,
        message: readyMessage,
      });
      this.output.appendLine(
        `Graph published (${options.reason}) revision=${graph.revision.slice(0, 20)}… nodes=${graph.nodes.length}`,
      );
    } catch (err) {
      if (!isActiveRequest(seq, this.graphRequestSeq, this.disposed)) return;
      this.handleEngineError(err);
    }
  }

  private async loadTemporalTimeline(): Promise<void> {
    const folder = resolveWorkspaceFolder();
    if (!folder) {
      this.postStatus('no_workspace', 'Open a folder or workspace to use PreBase.');
      return;
    }
    const seq = ++this.temporalRequestSeq;
    try {
      if (!this.engine.isReady) await this.engine.start();
      const result = await this.engine.listTemporalHistory(
        folder.uri.fsPath,
        this.temporalStoragePath(folder.uri.fsPath),
        40,
      );
      if (!isActiveRequest(seq, this.temporalRequestSeq, this.disposed)) return;
      this.post({
        type: 'temporalTimeline',
        timeline: result.timeline,
        isShallow: result.isShallow,
        note: result.note,
      });
      this.postStatus(
        'temporal_ready',
        result.timeline.length
          ? `Temporal timeline: ${result.timeline.length} first-parent commit(s). Index to build architecture snapshots.`
          : 'No commits found.',
        folder.name,
        folder.uri.fsPath,
      );
    } catch (err) {
      if (!isActiveRequest(seq, this.temporalRequestSeq, this.disposed)) return;
      this.handleEngineError(err);
    }
  }

  private async indexTemporal(limit?: number): Promise<void> {
    const folder = resolveWorkspaceFolder();
    if (!folder) {
      this.postStatus('no_workspace', 'Open a folder or workspace to use PreBase.');
      return;
    }
    const seq = ++this.temporalRequestSeq;
    this.postStatus(
      'indexing_history',
      'Indexing historical architecture (read-only Git objects)…',
      folder.name,
      folder.uri.fsPath,
    );
    try {
      if (!this.engine.isReady) await this.engine.start();
      const result = await this.engine.indexTemporalHistory(
        folder.uri.fsPath,
        this.temporalStoragePath(folder.uri.fsPath),
        limit ?? 40,
      );
      if (!isActiveRequest(seq, this.temporalRequestSeq, this.disposed)) return;
      this.post({ type: 'temporalIndexResult', result });
      this.post({
        type: 'temporalTimeline',
        timeline: result.timeline,
        isShallow: result.isShallow,
        note: result.note,
      });
      this.postStatus(
        'temporal_ready',
        `Indexed ${result.snapshotsComplete}/${result.commitsEnumerated} snapshots (${result.uniqueDigests} unique digests) in ${result.durationMs}ms.`,
        folder.name,
        folder.uri.fsPath,
      );
    } catch (err) {
      if (!isActiveRequest(seq, this.temporalRequestSeq, this.disposed)) return;
      this.handleEngineError(err);
    }
  }

  private async loadTemporalSnapshot(commitOid: string): Promise<void> {
    const folder = resolveWorkspaceFolder();
    if (!folder) return;
    const seq = ++this.temporalRequestSeq;
    this.postStatus(
      'loading_graph',
      `Loading historical graph for ${commitOid.slice(0, 12)}…`,
      folder.name,
      folder.uri.fsPath,
    );
    try {
      if (!this.engine.isReady) await this.engine.start();
      const result = await this.engine.getTemporalSnapshot(
        folder.uri.fsPath,
        this.temporalStoragePath(folder.uri.fsPath),
        commitOid,
      );
      if (!isActiveRequest(seq, this.temporalRequestSeq, this.disposed)) return;
      this.post({ type: 'temporalSnapshot', result });
      this.postStatus(
        'temporal_ready',
        `Historical graph @ ${commitOid.slice(0, 12)}: ${result.graph.nodes.length} nodes, ${result.graph.edges.length} edges.`,
        folder.name,
        folder.uri.fsPath,
      );
    } catch (err) {
      if (!isActiveRequest(seq, this.temporalRequestSeq, this.disposed)) return;
      this.handleEngineError(err);
    }
  }

  private async compareTemporal(baseOid: string, targetOid: string): Promise<void> {
    const folder = resolveWorkspaceFolder();
    if (!folder) return;
    const seq = ++this.temporalRequestSeq;
    this.postStatus(
      'loading_graph',
      `Comparing ${baseOid.slice(0, 8)} → ${targetOid.slice(0, 8)}…`,
      folder.name,
      folder.uri.fsPath,
    );
    try {
      if (!this.engine.isReady) await this.engine.start();
      const result = await this.engine.compareTemporalSnapshots(
        this.temporalStoragePath(folder.uri.fsPath),
        baseOid,
        targetOid,
      );
      if (!isActiveRequest(seq, this.temporalRequestSeq, this.disposed)) return;
      this.post({ type: 'temporalCompareResult', result });
      const s = result.delta.summary;
      this.postStatus(
        'temporal_ready',
        s.unchanged
          ? 'No architectural graph changes between selected commits.'
          : `Delta: +${s.nodesAdded}/-${s.nodesRemoved} nodes, +${s.edgesAdded}/-${s.edgesRemoved} edges.`,
        folder.name,
        folder.uri.fsPath,
      );
    } catch (err) {
      if (!isActiveRequest(seq, this.temporalRequestSeq, this.disposed)) return;
      this.handleEngineError(err);
    }
  }

  private handleEngineError(err: unknown): void {
    const message =
      err instanceof Error ? err.message : 'Unexpected engine error';
    const category =
      err instanceof EngineClientError ? err.category : 'internal';
    this.output.appendLine(`Engine error [${category}]: ${message}`);

    const status: HostStatus =
      category === 'engine_not_ready' ? 'engine_disconnected' : 'request_failed';

    this.postStatus(status, message);
    this.post({
      type: 'error',
      category,
      message,
      recoverable: true,
    });
  }

  private postStatus(
    status: HostStatus,
    message: string,
    workspaceName?: string,
    workspacePath?: string,
  ): void {
    this.post({
      type: 'status',
      status,
      message,
      workspaceName,
      workspacePath,
    });
  }

  private post(message: HostToWebview): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'webview.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'webview.css'),
    );
    const nonce = getNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      // Nonce for the bootstrap script; cspSource covers the packaged media URI.
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `connect-src 'none'`,
      `frame-src 'none'`,
      `object-src 'none'`,
      `base-uri 'none'`,
      `form-action 'none'`,
      `worker-src 'none'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>PreBase</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.disposed = true;
    this.teardownWatcher();
    this.folderChangeSub?.dispose();
    this.folderChangeSub = undefined;
    PreBasePanel.current = undefined;
    this.engine.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}

function getNonce(): string {
  return randomBytes(16).toString('base64url');
}
