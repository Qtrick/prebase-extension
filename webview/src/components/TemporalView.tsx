import { useMemo, useState } from 'react';
import type {
  CanonicalGraph,
  GraphDelta,
  TemporalSnapshotResult,
  TemporalTimelineEntry,
} from '@prebase/protocol';
import { NetworkGraphView } from '../graph/NetworkGraphView';
import { Inspector } from './Inspector';

interface Props {
  timeline: TemporalTimelineEntry[];
  isShallow: boolean;
  note?: string;
  snapshot: TemporalSnapshotResult | null;
  compareGraph: CanonicalGraph | null;
  compareBaseGraph: CanonicalGraph | null;
  delta: GraphDelta | null;
  indexing: boolean;
  onIndex: () => void;
  onSelectCommit: (oid: string) => void;
  onCompare: (baseOid: string, targetOid: string) => void;
  onClearCompare: () => void;
}

export function TemporalView({
  timeline,
  isShallow,
  note,
  snapshot,
  compareGraph,
  compareBaseGraph,
  delta,
  indexing,
  onIndex,
  onSelectCommit,
  onCompare,
  onClearCompare,
}: Props) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [baseOid, setBaseOid] = useState('');
  const [targetOid, setTargetOid] = useState('');

  const displayGraph = compareGraph ?? snapshot?.graph ?? null;
  const selectedNode = useMemo(
    () => displayGraph?.nodes.find((n) => n.id === selectedNodeId) ?? null,
    [displayGraph, selectedNodeId],
  );

  const changeSet = useMemo(() => {
    if (!delta) return null;
    return {
      nodesAdded: new Set(delta.nodesAdded),
      nodesRemoved: new Set(delta.nodesRemoved),
      edgesAdded: new Set(delta.edgesAdded),
      edgesRemoved: new Set(delta.edgesRemoved),
    };
  }, [delta]);

  const projectedNodes = useMemo(() => {
    if (!displayGraph) return [];
    if (!delta || !compareGraph || !compareBaseGraph) return displayGraph.nodes;
    const byId = new Map(displayGraph.nodes.map((n) => [n.id, n]));
    for (const id of delta.nodesRemoved) {
      const baseNode = compareBaseGraph.nodes.find((n) => n.id === id);
      if (baseNode && !byId.has(id)) {
        byId.set(id, baseNode);
      }
    }
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }, [compareBaseGraph, compareGraph, delta, displayGraph]);

  const projectedEdges = useMemo(() => {
    if (!displayGraph) return [];
    if (!delta || !compareGraph || !compareBaseGraph) return displayGraph.edges;
    const byId = new Map(displayGraph.edges.map((e) => [e.id, e]));
    for (const id of delta.edgesRemoved) {
      const baseEdge = compareBaseGraph.edges.find((e) => e.id === id);
      if (baseEdge && !byId.has(id)) {
        byId.set(id, baseEdge);
      }
    }
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }, [compareBaseGraph, compareGraph, delta, displayGraph]);

  return (
    <div className="temporal-layout" role="region" aria-label="Temporal graph">
      <aside className="temporal-timeline" aria-label="Architecture history timeline">
        <div className="temporal-timeline-header">
          <h2>History</h2>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onIndex}
            disabled={indexing}
          >
            {indexing ? 'Indexing…' : 'Index history'}
          </button>
        </div>
        {isShallow ? (
          <p className="muted small" role="status">
            Shallow clone detected. Older commits may be unavailable.
          </p>
        ) : null}
        {note ? <p className="muted small">{note}</p> : null}
        <ol className="timeline-list">
          {timeline.map((entry) => {
            const active = snapshot?.commit.oid === entry.commit.oid;
            return (
              <li key={entry.commit.oid}>
                <button
                  type="button"
                  className={`timeline-item${active ? ' is-active' : ''}`}
                  onClick={() => onSelectCommit(entry.commit.oid)}
                  aria-current={active ? 'true' : undefined}
                >
                  <span className="mono">{entry.commit.oid.slice(0, 8)}</span>
                  <span className={`status-dot status-${entry.status}`} title={entry.status} />
                  <span className="timeline-summary">{entry.commit.summary || '(no subject)'}</span>
                </button>
              </li>
            );
          })}
        </ol>
        {timeline.length === 0 ? (
          <p className="muted">No commits yet. Open a Git repository and index history.</p>
        ) : null}

        <div className="compare-controls">
          <h3>Compare</h3>
          <label className="toolbar-field block">
            <span className="sr-only">Base commit</span>
            <select
              value={baseOid}
              onChange={(e) => setBaseOid(e.target.value)}
              aria-label="Comparison base commit"
            >
              <option value="">Base…</option>
              {timeline.map((e) => (
                <option key={`b-${e.commit.oid}`} value={e.commit.oid}>
                  {e.commit.oid.slice(0, 8)} {e.commit.summary}
                </option>
              ))}
            </select>
          </label>
          <label className="toolbar-field block">
            <span className="sr-only">Target commit</span>
            <select
              value={targetOid}
              onChange={(e) => setTargetOid(e.target.value)}
              aria-label="Comparison target commit"
            >
              <option value="">Target…</option>
              {timeline.map((e) => (
                <option key={`t-${e.commit.oid}`} value={e.commit.oid}>
                  {e.commit.oid.slice(0, 8)} {e.commit.summary}
                </option>
              ))}
            </select>
          </label>
          <div className="inspector-actions">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!baseOid || !targetOid}
              onClick={() => onCompare(baseOid, targetOid)}
            >
              Compare
            </button>
            {delta ? (
              <button type="button" className="btn btn-secondary" onClick={onClearCompare}>
                Clear compare
              </button>
            ) : null}
          </div>
          {delta ? (
            <dl className="inspector-dl compact" aria-label="Delta summary">
              <div>
                <dt>Nodes +/−</dt>
                <dd>
                  +{delta.summary.nodesAdded} / −{delta.summary.nodesRemoved}
                </dd>
              </div>
              <div>
                <dt>Edges +/−</dt>
                <dd>
                  +{delta.summary.edgesAdded} / −{delta.summary.edgesRemoved}
                </dd>
              </div>
              <div>
                <dt>Unchanged</dt>
                <dd>{delta.summary.unchanged ? 'yes' : 'no'}</dd>
              </div>
            </dl>
          ) : null}
        </div>
      </aside>

      <div className="temporal-main">
        {snapshot ? (
          <div className="fixture-banner" role="note">
            Historical graph for{' '}
            <span className="mono">{snapshot.commit.oid.slice(0, 12)}</span>
            {': '}
            {snapshot.commit.summary}
            {displayGraph?.provenance === 'historical'
              ? ' (Git tree analysis; not the working tree).'
              : null}
          </div>
        ) : (
          <div className="empty-panel">
            <h2>Temporal Graph</h2>
            <p className="muted">
              Index history to reconstruct architecture snapshots from Git objects without
              checking out commits. This is not a commit graph; it shows structural dependency
              changes.
            </p>
          </div>
        )}

        {displayGraph && projectedNodes.length > 0 ? (
          <NetworkGraphView
            graph={displayGraph}
            nodes={projectedNodes}
            edges={projectedEdges}
            selectedNodeId={selectedNodeId}
            focusNodeId={focusNodeId}
            pathNodeIds={null}
            edgeEmphasis="both"
            changeHighlight={
              changeSet
                ? {
                    nodesAdded: changeSet.nodesAdded,
                    nodesRemoved: changeSet.nodesRemoved,
                    edgesAdded: changeSet.edgesAdded,
                    edgesRemoved: changeSet.edgesRemoved,
                  }
                : null
            }
            onSelectNode={(id) => {
              setSelectedNodeId(id);
              if (id) setFocusNodeId(id);
            }}
            revision={displayGraph.revision}
          />
        ) : snapshot ? (
          <div className="empty-panel">
            <h2>Empty historical graph</h2>
            <p className="muted">No supported source files at this commit.</p>
          </div>
        ) : null}

        <Inspector
          node={selectedNode}
          graph={displayGraph}
          onSelectNode={(id) => {
            setSelectedNodeId(id);
            setFocusNodeId(id);
          }}
        />

        {delta && !delta.summary.unchanged ? (
          <section className="delta-lists" aria-label="Structural changes">
            <div>
              <h3>Added edges</h3>
              <ul>
                {delta.edgesAdded.map((id) => (
                  <li key={id} className="mono">
                    + {id}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3>Removed edges</h3>
              <ul>
                {delta.edgesRemoved.map((id) => (
                  <li key={id} className="mono">
                    − {id}
                  </li>
                ))}
              </ul>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
