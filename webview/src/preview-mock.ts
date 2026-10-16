/**
 * Dev-only host mock for `npm run dev -w webview`.
 * Responds after the webview posts `ready`, matching extension host behavior.
 */
import type { CanonicalGraph, HostToWebview, WebviewToHost } from '@prebase/protocol';
import { isRecord } from '@prebase/protocol';

const graph: CanonicalGraph = {
  nodes: [
    { id: 'mod:app', kind: 'module', label: 'app', path: 'src' },
    {
      id: 'file:src/extension.ts',
      kind: 'file',
      label: 'extension.ts',
      path: 'src/extension.ts',
      language: 'typescript',
      parentId: 'mod:app',
    },
    {
      id: 'fn:activate',
      kind: 'function',
      label: 'activate',
      path: 'src/extension.ts',
      parentId: 'file:src/extension.ts',
      language: 'typescript',
      location: { path: 'src/extension.ts', line: 12, column: 1 },
    },
    {
      id: 'mod:engine',
      kind: 'module',
      label: 'prebase-engine',
      path: 'crates/prebase-engine',
      language: 'rust',
    },
    {
      id: 'comp:NetworkGraphView',
      kind: 'component',
      label: 'NetworkGraphView',
      path: 'webview/src/graph/NetworkGraphView.tsx',
      language: 'tsx',
    },
  ],
  edges: [
    {
      id: 'e1',
      source: 'mod:app',
      target: 'file:src/extension.ts',
      kind: 'contains',
    },
    {
      id: 'e2',
      source: 'file:src/extension.ts',
      target: 'fn:activate',
      kind: 'contains',
    },
    {
      id: 'e3',
      source: 'file:src/extension.ts',
      target: 'mod:engine',
      kind: 'dependency',
    },
    {
      id: 'e4',
      source: 'comp:NetworkGraphView',
      target: 'mod:engine',
      kind: 'reference',
    },
  ],
  projectPath: '/preview',
  projectName: 'prebase-preview',
  entryNodeId: 'mod:app',
  revision: 'fixture-v1',
  provenance: 'fixture',
  versions: {
    graphSchemaVersion: 1,
    analyzerVersion: 1,
    identityVersion: 1,
  },
  provenanceNote:
    'Preview mock sample graph. Prefer the Extension Development Host for real repository analysis.',
  coverage: {
    discoveredFiles: 5,
    analyzedFiles: 5,
    unsupportedFiles: 0,
    parseFailures: 0,
    resolvedImports: 3,
    unresolvedImports: 0,
    externalImports: 1,
    ambiguousImports: 0,
    excludedPaths: 0,
    durationMs: 12,
  },
};

function emit(msg: HostToWebview): void {
  window.dispatchEvent(new MessageEvent('message', { data: msg }));
}

function deliverGraph(): void {
  emit({
    type: 'status',
    status: 'loading_graph',
    message: 'Loading network graph…',
    workspaceName: 'prebase-preview',
    workspacePath: '/preview',
  });
  window.setTimeout(() => {
    emit({
      type: 'graph',
      graph,
      status: 'graph_ready',
      message: 'Network graph ready (sample data).',
    });
  }, 250);
}

export function installPreviewMock(): void {
  if (typeof acquireVsCodeApi === 'function') return;

  const api = {
    postMessage(message: unknown) {
      if (!isRecord(message) || typeof message.type !== 'string') return;
      const msg = message as WebviewToHost;
      if (msg.type === 'ready' || msg.type === 'requestGraph' || msg.type === 'retry') {
        emit({
          type: 'status',
          status: 'engine_starting',
          message: 'Preview mock: starting engine…',
          workspaceName: 'prebase-preview',
          workspacePath: '/preview',
        });
        window.setTimeout(deliverGraph, 200);
      }
    },
    getState: () => undefined,
    setState: () => undefined,
  };

  (window as unknown as { acquireVsCodeApi: () => typeof api }).acquireVsCodeApi = () => api;
}

declare function acquireVsCodeApi(): unknown;
