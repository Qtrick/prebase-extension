import { useEffect, useMemo, useState } from 'react';
import type {
  CanonicalGraph,
  GraphDelta,
  HostStatus,
  HostToWebview,
  TemporalSnapshotResult,
  TemporalTimelineEntry,
} from '@prebase/protocol';
import { isCanonicalGraph, isRecord } from '@prebase/protocol';
import { postToHost } from './bridge/vscodeApi';
import { Inspector } from './components/Inspector';
import { StatusBanner } from './components/StatusBanner';
import { TemporalView } from './components/TemporalView';
import { NetworkGraphView } from './graph/NetworkGraphView';
import {
  connectedComponents,
  findDependencyPath,
  languagesInGraph,
  pathEdgeKeysFromPath,
  projectGraph,
  type EdgeEmphasis,
} from './graph/projectGraph';
import { ThinkingOrb } from './vendor/ThinkingOrb';

type ViewMode = 'network' | 'temporal';

export function App() {
  const [view, setView] = useState<ViewMode>('network');
  const [status, setStatus] = useState<HostStatus>('initializing');
  const [message, setMessage] = useState('Initializing PreBase…');
  const [workspaceName, setWorkspaceName] = useState<string | undefined>();
  const [graph, setGraph] = useState<CanonicalGraph | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [recoverable, setRecoverable] = useState(false);
  const [query, setQuery] = useState('');
  const [language, setLanguage] = useState('');
  const [connectedOnly, setConnectedOnly] = useState(false);
  const [neighborhoodFocus, setNeighborhoodFocus] = useState(false);
  const [edgeEmphasis, setEdgeEmphasis] = useState<EdgeEmphasis>('both');
  const [pathTargetId, setPathTargetId] = useState<string>('');
  const [fitRequest, setFitRequest] = useState(0);
  const [componentIndex, setComponentIndex] = useState(0);
  const [timeline, setTimeline] = useState<TemporalTimelineEntry[]>([]);
  const [timelineShallow, setTimelineShallow] = useState(false);
  const [timelineNote, setTimelineNote] = useState<string | undefined>();
  const [temporalSnapshot, setTemporalSnapshot] =
    useState<TemporalSnapshotResult | null>(null);
  const [compareGraph, setCompareGraph] = useState<CanonicalGraph | null>(null);
  const [compareBaseGraph, setCompareBaseGraph] = useState<CanonicalGraph | null>(null);
  const [delta, setDelta] = useState<GraphDelta | null>(null);
  const [indexing, setIndexing] = useState(false);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as HostToWebview;
      if (!isRecord(data) || typeof data.type !== 'string') return;

      if (data.type === 'status') {
        setStatus(data.status);
        setMessage(data.message);
        if (data.workspaceName) setWorkspaceName(data.workspaceName);
        setRecoverable(
          data.status === 'request_failed' ||
            data.status === 'engine_disconnected' ||
            data.status === 'analysis_unavailable',
        );
        return;
      }

      if (data.type === 'graph' && isCanonicalGraph(data.graph)) {
        setGraph(data.graph);
        setStatus(data.status);
        setMessage(data.message);
        setRecoverable(false);
        setSelectedNodeId((prev) =>
          prev && data.graph.nodes.some((n) => n.id === prev) ? prev : null,
        );
        setPathTargetId((prev) =>
          prev && data.graph.nodes.some((n) => n.id === prev) ? prev : '',
        );
        return;
      }

      if (data.type === 'error') {
        setStatus(
          data.category === 'engine_not_ready'
            ? 'engine_disconnected'
            : 'request_failed',
        );
        setMessage(data.message);
        setRecoverable(data.recoverable);
        setIndexing(false);
        return;
      }

      if (data.type === 'temporalTimeline') {
        setTimeline(data.timeline);
        setTimelineShallow(data.isShallow);
        setTimelineNote(data.note);
        setIndexing(false);
        return;
      }

      if (data.type === 'temporalIndexResult') {
        setTimeline(data.result.timeline);
        setTimelineShallow(data.result.isShallow);
        setTimelineNote(data.result.note);
        setIndexing(false);
        return;
      }

      if (data.type === 'temporalSnapshot') {
        setTemporalSnapshot(data.result);
        setCompareGraph(null);
        setCompareBaseGraph(null);
        setDelta(null);
        return;
      }

      if (data.type === 'temporalCompareResult') {
        setCompareBaseGraph(data.result.baseGraph);
        setCompareGraph(data.result.targetGraph);
        setDelta(data.result.delta);
        return;
      }
    };

    window.addEventListener('message', onMessage);
    postToHost({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const languages = useMemo(
    () => (graph ? languagesInGraph(graph) : []),
    [graph],
  );

  const components = useMemo(
    () => (graph ? connectedComponents(graph) : []),
    [graph],
  );

  useEffect(() => {
    if (components.length === 0) {
      setComponentIndex(0);
      return;
    }
    setComponentIndex((i) => Math.min(i, components.length - 1));
  }, [components.length, graph?.revision]);

  const pathResult = useMemo(() => {
    if (!graph || !selectedNodeId || !pathTargetId) {
      return { nodeIds: null as Set<string> | null, edgeKeys: null as Set<string> | null };
    }
    const path = findDependencyPath(graph, selectedNodeId, pathTargetId);
    if (!path) {
      return { nodeIds: new Set<string>(), edgeKeys: new Set<string>() };
    }
    return {
      nodeIds: new Set(path),
      edgeKeys: pathEdgeKeysFromPath(path),
    };
  }, [graph, pathTargetId, selectedNodeId]);

  const pathIds = pathResult.nodeIds;
  const pathEdgeKeys = pathResult.edgeKeys;

  const pathMissing =
    Boolean(graph && selectedNodeId && pathTargetId) &&
    pathIds !== null &&
    pathIds.size === 0;

  const projection = useMemo(() => {
    if (!graph) return null;
    return projectGraph(graph, {
      query,
      language,
      connectedOnly,
      neighborhoodOf: neighborhoodFocus ? selectedNodeId : null,
      pathNodeIds: pathIds,
    });
  }, [
    connectedOnly,
    graph,
    language,
    neighborhoodFocus,
    pathIds,
    query,
    selectedNodeId,
  ]);

  const selectedNode = useMemo(
    () => graph?.nodes.find((n) => n.id === selectedNodeId) ?? null,
    [graph, selectedNodeId],
  );

  const showLoadingOverlay =
    !graph &&
    (status === 'initializing' ||
      status === 'engine_starting' ||
      status === 'loading_graph' ||
      status === 'retrying');

  const showUpdatingChip = Boolean(graph) && status === 'updating_graph';

  const onSelectView = (next: ViewMode) => {
    setView(next);
    postToHost({ type: 'setView', view: next });
    if (next === 'temporal') {
      setIndexing(false);
    }
  };

  const onSelectNode = (nodeId: string | null) => {
    setSelectedNodeId(nodeId);
    if (nodeId) setFocusNodeId(nodeId);
    postToHost({ type: 'selectNode', nodeId });
  };

  const onRetry = () => {
    setRecoverable(false);
    setStatus('retrying');
    setMessage('Retrying…');
    postToHost({ type: 'retry' });
  };

  const onSearchSelect = (nodeId: string) => {
    onSelectNode(nodeId);
    setQuery('');
  };

  const searchHits = useMemo(() => {
    if (!graph || !query.trim()) return [];
    const q = query.trim().toLowerCase();
    return graph.nodes
      .filter(
        (n) =>
          n.label.toLowerCase().includes(q) ||
          (n.path ?? '').toLowerCase().includes(q),
      )
      .slice(0, 12);
  }, [graph, query]);

  const focusComponent = (index: number) => {
    const comp = components[index];
    if (!comp?.length || !graph) return;
    setComponentIndex(index);
    onSelectNode(comp[0]!);
    setNeighborhoodFocus(false);
    setConnectedOnly(false);
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-block">
          <span className="brand">PreBase</span>
          <span className="workspace-name" title={workspaceName}>
            {workspaceName ?? 'No workspace'}
          </span>
        </div>
        <nav className="view-tabs" aria-label="Graph views">
          <button
            type="button"
            className={`tab${view === 'network' ? ' is-active' : ''}`}
            aria-pressed={view === 'network'}
            onClick={() => onSelectView('network')}
          >
            Network
          </button>
          <button
            type="button"
            className={`tab${view === 'temporal' ? ' is-active' : ''}`}
            aria-pressed={view === 'temporal'}
            onClick={() => onSelectView('temporal')}
          >
            Temporal
          </button>
        </nav>
        <div className="header-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => postToHost({ type: 'requestGraph' })}
            disabled={view !== 'network'}
          >
            Refresh
          </button>
        </div>
      </header>

      <StatusBanner
        status={status}
        message={message}
        onRetry={recoverable ? onRetry : undefined}
        recoverable={recoverable}
      />

      {graph?.provenance === 'fixture' ? (
        <div className="fixture-banner" role="note">
          {graph.provenanceNote ??
            'Sample data, not derived from this repository.'}
        </div>
      ) : null}

      {view === 'network' && graph ? (
        <div className="toolbar" role="toolbar" aria-label="Graph controls">
          <label className="toolbar-field">
            <span className="sr-only">Search graph</span>
            <input
              type="search"
              placeholder="Search files…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search graph nodes"
            />
          </label>
          <label className="toolbar-field">
            <span className="sr-only">Language filter</span>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              aria-label="Filter by language"
            >
              <option value="">All languages</option>
              {languages.map((lang) => (
                <option key={lang} value={lang}>
                  {lang}
                </option>
              ))}
            </select>
          </label>
          <label className="toolbar-check">
            <input
              type="checkbox"
              checked={connectedOnly}
              onChange={(e) => setConnectedOnly(e.target.checked)}
            />
            Connected only
          </label>
          <label className="toolbar-check">
            <input
              type="checkbox"
              checked={neighborhoodFocus}
              disabled={!selectedNodeId}
              onChange={(e) => setNeighborhoodFocus(e.target.checked)}
            />
            Neighborhood
          </label>
          <label className="toolbar-field">
            <span className="sr-only">Edge emphasis</span>
            <select
              value={edgeEmphasis}
              onChange={(e) => setEdgeEmphasis(e.target.value as EdgeEmphasis)}
              aria-label="Highlight edges"
            >
              <option value="both">Edges: both</option>
              <option value="outgoing">Edges: outgoing</option>
              <option value="incoming">Edges: incoming</option>
              <option value="none">Edges: none</option>
            </select>
          </label>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setFitRequest((n) => n + 1)}
          >
            Fit view
          </button>
          {components.length > 1 ? (
            <label className="toolbar-field">
              <span className="sr-only">Component</span>
              <select
                value={componentIndex}
                onChange={(e) => focusComponent(Number(e.target.value))}
                aria-label="Focus connected component"
              >
                {components.map((c, i) => (
                  <option key={c[0]} value={i}>
                    Component {i + 1} ({c.length})
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {(query ||
            language ||
            connectedOnly ||
            neighborhoodFocus ||
            pathTargetId) && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setQuery('');
                setLanguage('');
                setConnectedOnly(false);
                setNeighborhoodFocus(false);
                setPathTargetId('');
              }}
            >
              Reset filters
            </button>
          )}
          {searchHits.length > 0 && query.trim() ? (
            <div className="search-hits" role="listbox" aria-label="Search results">
              {searchHits.map((hit) => (
                <button
                  key={hit.id}
                  type="button"
                  role="option"
                  className="search-hit"
                  onClick={() => onSearchSelect(hit.id)}
                >
                  <span>{hit.label}</span>
                  <span className="muted mono">{hit.path}</span>
                </button>
              ))}
            </div>
          ) : null}
          {query.trim() && searchHits.length === 0 ? (
            <span className="muted" role="status">
              No matching nodes
            </span>
          ) : null}
          {showUpdatingChip ? (
            <span className="update-chip" role="status">
              <ThinkingOrb state="working" size={20} />
              Updating…
            </span>
          ) : null}
        </div>
      ) : null}

      <main className="app-main">
        <section className="graph-workspace" aria-label="Graph workspace">
          {view === 'network' ? (
            showLoadingOverlay ? (
              <div className="loading-panel" aria-busy="true">
                <ThinkingOrb state="searching" size={64} />
                <p className="muted">Analyzing repository</p>
              </div>
            ) : graph && projection && projection.nodes.length > 0 ? (
              <NetworkGraphView
                graph={graph}
                nodes={projection.nodes}
                edges={projection.edges}
                selectedNodeId={selectedNodeId}
                focusNodeId={focusNodeId}
                pathNodeIds={pathIds && pathIds.size > 0 ? pathIds : null}
                pathEdgeKeys={pathEdgeKeys && pathEdgeKeys.size > 0 ? pathEdgeKeys : null}
                edgeEmphasis={edgeEmphasis}
                onSelectNode={onSelectNode}
                onFitRequest={fitRequest}
                revision={graph.revision}
              />
            ) : status === 'empty_graph' || (graph && graph.nodes.length === 0) ? (
              <div className="empty-panel">
                <h2>Empty graph</h2>
                <p className="muted">
                  No supported source files produced graph nodes. PreBase currently
                  analyzes TypeScript, JavaScript, and Rust imports.
                </p>
              </div>
            ) : graph && projection && projection.nodes.length === 0 ? (
              <div className="empty-panel">
                <h2>No matches</h2>
                <p className="muted">Current filters hide every node.</p>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    setQuery('');
                    setLanguage('');
                    setConnectedOnly(false);
                    setNeighborhoodFocus(false);
                  }}
                >
                  Reset filters
                </button>
              </div>
            ) : (
              <div className="empty-panel">
                <h2>Graph unavailable</h2>
                <p className="muted">{message}</p>
                {recoverable ? (
                  <button type="button" className="btn btn-primary" onClick={onRetry}>
                    Retry
                  </button>
                ) : null}
              </div>
            )
          ) : (
            <TemporalView
              timeline={timeline}
              isShallow={timelineShallow}
              note={timelineNote}
              snapshot={temporalSnapshot}
              compareGraph={compareGraph}
              compareBaseGraph={compareBaseGraph}
              delta={delta}
              indexing={indexing || status === 'indexing_history'}
              onIndex={() => {
                setIndexing(true);
                postToHost({ type: 'temporalIndex', limit: 40 });
              }}
              onSelectCommit={(oid) => {
                setCompareGraph(null);
                setCompareBaseGraph(null);
                setDelta(null);
                postToHost({ type: 'temporalSelect', commitOid: oid });
              }}
              onCompare={(base, target) =>
                postToHost({
                  type: 'temporalCompare',
                  baseCommitOid: base,
                  targetCommitOid: target,
                })
              }
              onClearCompare={() => {
                setCompareGraph(null);
                setCompareBaseGraph(null);
                setDelta(null);
              }}
            />
          )}
        </section>
        {view === 'network' ? (
          <Inspector
            node={selectedNode}
            graph={graph}
            onSelectNode={onSelectNode}
            pathTargetId={pathTargetId}
            onPathTargetChange={setPathTargetId}
            pathMissing={pathMissing}
            pathLength={pathIds && pathIds.size > 0 ? pathIds.size : null}
            neighborhoodFocus={neighborhoodFocus}
            onToggleNeighborhood={() => setNeighborhoodFocus((v) => !v)}
          />
        ) : null}
      </main>
    </div>
  );
}
