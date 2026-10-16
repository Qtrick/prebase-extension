import type { CanonicalGraph, GraphNode } from '@prebase/protocol';
import { degreeOf, neighborIds } from '../graph/projectGraph';

interface Props {
  node: GraphNode | null;
  graph: CanonicalGraph | null;
  onSelectNode: (nodeId: string) => void;
  pathTargetId?: string;
  onPathTargetChange?: (id: string) => void;
  pathMissing?: boolean;
  pathLength?: number | null;
  neighborhoodFocus?: boolean;
  onToggleNeighborhood?: () => void;
}

export function Inspector({
  node,
  graph,
  onSelectNode,
  pathTargetId = '',
  onPathTargetChange,
  pathMissing = false,
  pathLength = null,
  neighborhoodFocus = false,
  onToggleNeighborhood,
}: Props) {
  if (!node || !graph) {
    return (
      <aside className="inspector" aria-label="Node inspector">
        <h2 className="inspector-title">Inspector</h2>
        <p className="muted">Select a node to inspect metadata and dependencies.</p>
        {graph?.coverage ? <CoverageStats graph={graph} /> : null}
      </aside>
    );
  }

  const { incoming, outgoing } = neighborIds(graph, node.id);
  const { inDegree, outDegree } = degreeOf(graph, node.id);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const outEdges = graph.edges.filter((e) => e.source === node.id);
  const inEdges = graph.edges.filter((e) => e.target === node.id);
  const pathCandidates = graph.nodes
    .filter((n) => n.id !== node.id)
    .slice()
    .sort((a, b) => a.label.localeCompare(b.label));

  return (
    <aside className="inspector" aria-label="Node inspector">
      <h2 className="inspector-title">Inspector</h2>
      <dl className="inspector-dl">
        <div>
          <dt>Label</dt>
          <dd title={node.label}>{node.label}</dd>
        </div>
        <div>
          <dt>Kind</dt>
          <dd>
            <span className={`kind-badge kind-${node.kind}`}>{node.kind}</span>
          </dd>
        </div>
        <div>
          <dt>ID</dt>
          <dd className="mono" title={node.id}>
            {node.id}
          </dd>
        </div>
        {node.path ? (
          <div>
            <dt>Path</dt>
            <dd className="mono" title={node.path}>
              {node.path}
            </dd>
          </div>
        ) : null}
        {node.language ? (
          <div>
            <dt>Language</dt>
            <dd>{node.language}</dd>
          </div>
        ) : null}
        <div>
          <dt>Out / in degree</dt>
          <dd>
            {outDegree} / {inDegree}
            <span className="muted"> (hop counts, not importance)</span>
          </dd>
        </div>
        <div>
          <dt>Imports</dt>
          <dd>{outgoing.size}</dd>
        </div>
        <div>
          <dt>Imported by</dt>
          <dd>{incoming.size}</dd>
        </div>
      </dl>

      <div className="inspector-actions">
        {onToggleNeighborhood ? (
          <button
            type="button"
            className="btn btn-secondary"
            aria-pressed={neighborhoodFocus}
            onClick={onToggleNeighborhood}
          >
            {neighborhoodFocus ? 'Show full graph' : 'Focus neighborhood'}
          </button>
        ) : null}
      </div>

      {onPathTargetChange ? (
        <section className="inspector-section">
          <h3>Dependency path</h3>
          <p className="muted small">
            Shortest directed hop path from the selected node. Not an architectural ranking.
          </p>
          <label className="toolbar-field block">
            <span className="sr-only">Path destination</span>
            <select
              value={pathTargetId}
              onChange={(e) => onPathTargetChange(e.target.value)}
              aria-label="Path destination node"
            >
              <option value="">Select destination…</option>
              {pathCandidates.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.label}
                  {n.path ? ` (${n.path})` : ''}
                </option>
              ))}
            </select>
          </label>
          {pathTargetId && pathLength ? (
            <p className="muted" role="status">
              Path length: {pathLength - 1} hop(s), {pathLength} node(s).
            </p>
          ) : null}
          {pathMissing ? (
            <p className="muted" role="status">
              No directed dependency path to that node.
            </p>
          ) : null}
        </section>
      ) : null}

      {outEdges.length > 0 ? (
        <section className="inspector-section">
          <h3>Outgoing</h3>
          <ul className="dep-list">
            {outEdges.map((e) => {
              const target = byId.get(e.target);
              return (
                <li key={e.id}>
                  <button
                    type="button"
                    className="linkish"
                    onClick={() => onSelectNode(e.target)}
                  >
                    {target?.label ?? e.target}
                  </button>
                  <span className="muted mono">
                    {e.specifier ?? e.kind}
                    {e.resolution ? ` · ${e.resolution}` : ''}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {inEdges.length > 0 ? (
        <section className="inspector-section">
          <h3>Incoming</h3>
          <ul className="dep-list">
            {inEdges.map((e) => {
              const source = byId.get(e.source);
              return (
                <li key={e.id}>
                  <button
                    type="button"
                    className="linkish"
                    onClick={() => onSelectNode(e.source)}
                  >
                    {source?.label ?? e.source}
                  </button>
                  <span className="muted mono">{e.specifier ?? e.kind}</span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {graph.coverage ? <CoverageStats graph={graph} /> : null}
    </aside>
  );
}

function CoverageStats({ graph }: { graph: CanonicalGraph }) {
  const c = graph.coverage!;
  return (
    <section className="inspector-section coverage" aria-label="Analysis coverage">
      <h3>Analysis</h3>
      <dl className="inspector-dl compact">
        <div>
          <dt>Analyzed</dt>
          <dd>
            {c.analyzedFiles}/{c.discoveredFiles}
          </dd>
        </div>
        <div>
          <dt>Resolved</dt>
          <dd>{c.resolvedImports}</dd>
        </div>
        <div>
          <dt>Unresolved</dt>
          <dd>{c.unresolvedImports}</dd>
        </div>
        <div>
          <dt>External</dt>
          <dd>{c.externalImports}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{c.durationMs}ms</dd>
        </div>
        <div>
          <dt>Revision</dt>
          <dd className="mono" title={graph.revision}>
            {graph.revision.slice(0, 16)}…
          </dd>
        </div>
      </dl>
    </section>
  );
}
