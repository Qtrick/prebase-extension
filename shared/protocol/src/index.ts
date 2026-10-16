/**
 * Shared PreBase message contracts.
 * Mirrored by crates/prebase-engine/src/{domain,protocol}.rs
 */

export const PROTOCOL_VERSION = 1 as const;

export type NodeKind =
  | 'folder'
  | 'file'
  | 'function'
  | 'component'
  | 'service'
  | 'module';

export type EdgeKind =
  | 'import'
  | 'export'
  | 'reference'
  | 'contains'
  | 'dependency';

export type GraphProvenance = 'fixture' | 'repository' | 'historical';

export type ResolutionStatus = 'resolved' | 'unresolved' | 'external' | 'ambiguous';

export type EvidenceKind = 'syntax_import' | 'heuristic';

export type ErrorCategory =
  | 'invalid_request'
  | 'unsupported_version'
  | 'unknown_method'
  | 'engine_not_ready'
  | 'analysis_unavailable'
  | 'timeout'
  | 'internal';

export interface SourceLocation {
  path: string;
  line?: number;
  column?: number;
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  path?: string;
  parentId?: string;
  language?: string;
  location?: SourceLocation;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  resolution?: ResolutionStatus;
  specifier?: string;
  evidence?: EvidenceKind;
  location?: SourceLocation;
}

export interface GraphVersions {
  graphSchemaVersion: number;
  analyzerVersion: number;
  identityVersion: number;
}

export interface GraphCoverage {
  discoveredFiles: number;
  analyzedFiles: number;
  unsupportedFiles: number;
  parseFailures: number;
  resolvedImports: number;
  unresolvedImports: number;
  externalImports: number;
  ambiguousImports: number;
  excludedPaths: number;
  durationMs: number;
}

export interface CanonicalGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  projectPath: string;
  projectName: string;
  entryNodeId: string | null;
  revision: string;
  provenance: GraphProvenance;
  versions: GraphVersions;
  provenanceNote?: string;
  coverage?: GraphCoverage;
}

export interface EngineRequest {
  protocolVersion: number;
  id: string;
  method: string;
  params?: unknown;
}

export interface EngineErrorBody {
  category: ErrorCategory;
  message: string;
  details?: string;
}

export interface EngineResponse {
  protocolVersion: number;
  id: string;
  result?: unknown;
  error?: EngineErrorBody;
}

export interface InitializeResult {
  engineVersion: string;
  protocolVersion: number;
  capabilities: {
    networkGraph: boolean;
    temporalGraph: boolean;
    fixtureGraph: boolean;
  };
}

export interface GetNetworkGraphResult {
  graph: CanonicalGraph;
}

/** Webview ↔ Extension Host messages */
export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'requestGraph' }
  | { type: 'selectNode'; nodeId: string | null }
  | { type: 'retry' }
  | { type: 'setView'; view: 'network' | 'temporal' }
  | { type: 'temporalIndex'; limit?: number }
  | { type: 'temporalSelect'; commitOid: string }
  | {
      type: 'temporalCompare';
      baseCommitOid: string;
      targetCommitOid: string;
    };

export type HostStatus =
  | 'initializing'
  | 'engine_starting'
  | 'engine_ready'
  | 'loading_graph'
  | 'updating_graph'
  | 'indexing_history'
  | 'graph_ready'
  | 'temporal_ready'
  | 'empty_graph'
  | 'no_workspace'
  | 'analysis_unavailable'
  | 'request_failed'
  | 'engine_disconnected'
  | 'retrying';

export type HostToWebview =
  | {
      type: 'status';
      status: HostStatus;
      message: string;
      workspaceName?: string;
      workspacePath?: string;
    }
  | {
      type: 'graph';
      graph: CanonicalGraph;
      status: HostStatus;
      message: string;
    }
  | {
      type: 'error';
      category: ErrorCategory | 'webview' | 'lifecycle';
      message: string;
      recoverable: boolean;
    }
  | { type: 'ack'; intent: string }
  | {
      type: 'temporalTimeline';
      timeline: TemporalTimelineEntry[];
      isShallow: boolean;
      note?: string;
    }
  | {
      type: 'temporalIndexResult';
      result: TemporalIndexResult;
    }
  | {
      type: 'temporalSnapshot';
      result: TemporalSnapshotResult;
    }
  | {
      type: 'temporalCompareResult';
      result: TemporalCompareResult;
    };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseEngineResponse(value: unknown): EngineResponse | null {
  if (!isRecord(value)) return null;
  if (value.protocolVersion !== PROTOCOL_VERSION) return null;
  if (typeof value.id !== 'string') return null;
  if (value.error !== undefined && !isRecord(value.error)) return null;
  return value as unknown as EngineResponse;
}

export function isCanonicalGraph(value: unknown): value is CanonicalGraph {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.nodes) &&
    Array.isArray(value.edges) &&
    typeof value.projectPath === 'string' &&
    typeof value.revision === 'string' &&
    (value.provenance === 'fixture' ||
      value.provenance === 'repository' ||
      value.provenance === 'historical')
  );
}

export interface TemporalCommitInfo {
  oid: string;
  parents: string[];
  summary: string;
  author: string;
  timeSeconds: number;
}

export interface TemporalTimelineEntry {
  commit: TemporalCommitInfo;
  status: string;
  digest?: string | null;
  error?: string | null;
}

export interface TemporalIndexResult {
  commitsEnumerated: number;
  snapshotsComplete: number;
  snapshotsFailed: number;
  uniqueDigests: number;
  durationMs: number;
  isShallow: boolean;
  timeline: TemporalTimelineEntry[];
  analyzerVersion: number;
  temporalSchemaVersion: number;
  note: string;
}

export interface TemporalSnapshotResult {
  commit: TemporalCommitInfo;
  digest: string;
  graph: CanonicalGraph;
  status: string;
}

export interface GraphDeltaSummary {
  nodesAdded: number;
  nodesRemoved: number;
  edgesAdded: number;
  edgesRemoved: number;
  unchanged: boolean;
}

export interface GraphDelta {
  baseCommitOid: string;
  targetCommitOid: string;
  baseDigest: string;
  targetDigest: string;
  nodesAdded: string[];
  nodesRemoved: string[];
  edgesAdded: string[];
  edgesRemoved: string[];
  summary: GraphDeltaSummary;
}

export interface TemporalCompareResult {
  delta: GraphDelta;
  baseGraph: CanonicalGraph;
  targetGraph: CanonicalGraph;
}
