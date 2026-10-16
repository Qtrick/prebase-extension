import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CanonicalGraph, GraphEdge, GraphNode } from '@prebase/protocol';
import { layoutGraph } from './layout';
import { neighborIds, pathEdgePairKey, type EdgeEmphasis } from './projectGraph';

export interface ChangeHighlight {
  nodesAdded: Set<string>;
  nodesRemoved: Set<string>;
  edgesAdded: Set<string>;
  edgesRemoved: Set<string>;
}

interface Props {
  graph: CanonicalGraph;
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedNodeId: string | null;
  focusNodeId: string | null;
  pathNodeIds?: Set<string> | null;
  pathEdgeKeys?: Set<string> | null;
  edgeEmphasis?: EdgeEmphasis;
  changeHighlight?: ChangeHighlight | null;
  onSelectNode: (nodeId: string | null) => void;
  onFitRequest?: number;
  /** Bump when graph revision changes but keep camera when possible. */
  revision?: string;
}

const KIND_SHAPE: Record<string, 'circle' | 'rounded' | 'diamond'> = {
  module: 'rounded',
  folder: 'rounded',
  file: 'circle',
  function: 'circle',
  component: 'diamond',
  service: 'rounded',
};

export function NetworkGraphView({
  graph,
  nodes,
  edges,
  selectedNodeId,
  focusNodeId,
  pathNodeIds = null,
  pathEdgeKeys = null,
  edgeEmphasis = 'both',
  changeHighlight = null,
  onSelectNode,
  onFitRequest = 0,
  revision,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const listId = useId();
  const [size, setSize] = useState({ w: 640, h: 420 });
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const prevPositions = useRef<Map<string, { x: number; y: number }>>(new Map());
  const lastRevision = useRef<string | undefined>(undefined);

  useEffect(() => {
    const el = svgRef.current?.parentElement;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setSize({ w: Math.max(rect.width, 240), h: Math.max(rect.height, 200) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const laidOut = useMemo(() => {
    const reuse =
      prevPositions.current.size > 0 ? prevPositions.current : null;
    const next = layoutGraph({ ...graph, nodes, edges }, size.w, size.h, reuse);
    const map = new Map<string, { x: number; y: number }>();
    for (const n of next) map.set(n.id, { x: n.x, y: n.y });
    prevPositions.current = map;
    lastRevision.current = revision;
    return next;
  }, [edges, graph, nodes, revision, size.h, size.w]);

  const byId = useMemo(() => new Map(laidOut.map((n) => [n.id, n])), [laidOut]);
  const neighbors = useMemo(
    () => neighborIds({ ...graph, nodes: graph.nodes, edges: graph.edges }, selectedNodeId),
    [graph, selectedNodeId],
  );

  useEffect(() => {
    if (!focusNodeId) return;
    const node = byId.get(focusNodeId);
    if (!node) return;
    setTransform((t) => ({
      ...t,
      x: size.w / 2 - node.x * t.k,
      y: size.h / 2 - node.y * t.k,
    }));
  }, [byId, focusNodeId, size.h, size.w]);

  useEffect(() => {
    if (!onFitRequest) return;
    setTransform({ x: 0, y: 0, k: 1 });
  }, [onFitRequest]);

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.92 : 1.08;
    setTransform((t) => ({
      ...t,
      k: Math.min(2.5, Math.max(0.35, t.k * factor)),
    }));
  };

  const selected = selectedNodeId ? byId.get(selectedNodeId) : undefined;
  const showLabels = transform.k >= 0.55 || nodes.length <= 40;

  return (
    <div className="graph-canvas" aria-label="Network graph canvas">
      <svg
        ref={svgRef}
        className="graph-svg"
        role="img"
        aria-labelledby={`${listId}-title`}
        onWheel={onWheel}
        onPointerDown={(e) => {
          if ((e.target as Element).closest('[data-node]')) return;
          drag.current = { px: e.clientX, py: e.clientY, x: transform.x, y: transform.y };
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          setTransform((t) => ({
            ...t,
            x: drag.current!.x + (e.clientX - drag.current!.px),
            y: drag.current!.y + (e.clientY - drag.current!.py),
          }));
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
      >
        <title id={`${listId}-title`}>
          Network graph with {nodes.length} nodes and {edges.length} edges
        </title>
        <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.k})`}>
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" className="graph-arrow" />
            </marker>
          </defs>
          {edges.map((edge) => {
            const s = byId.get(edge.source);
            const t = byId.get(edge.target);
            if (!s || !t) return null;
            const onPath = Boolean(
              pathEdgeKeys?.has(pathEdgePairKey(edge.source, edge.target)),
            );
            const added = Boolean(changeHighlight?.edgesAdded.has(edge.id));
            const removed = Boolean(changeHighlight?.edgesRemoved.has(edge.id));
            let emphasized = false;
            if (selectedNodeId) {
              if (edgeEmphasis === 'outgoing') {
                emphasized = edge.source === selectedNodeId;
              } else if (edgeEmphasis === 'incoming') {
                emphasized = edge.target === selectedNodeId;
              } else if (edgeEmphasis === 'both') {
                emphasized =
                  edge.source === selectedNodeId || edge.target === selectedNodeId;
              }
            }
            return (
              <line
                key={edge.id}
                x1={s.x}
                y1={s.y}
                x2={t.x}
                y2={t.y}
                className={`graph-edge${emphasized ? ' is-emphasized' : ''}${onPath ? ' is-path' : ''}${added ? ' is-added' : ''}${removed ? ' is-removed' : ''}`}
                markerEnd="url(#arrow)"
              >
                <title>
                  {edge.kind}
                  {edge.specifier ? `: ${edge.specifier}` : ''}
                </title>
              </line>
            );
          })}
          {laidOut.map((node) => {
            const isNeighbor =
              neighbors.incoming.has(node.id) || neighbors.outgoing.has(node.id);
            const onPath = Boolean(pathNodeIds?.has(node.id));
            const added = Boolean(changeHighlight?.nodesAdded.has(node.id));
            const removed = Boolean(changeHighlight?.nodesRemoved.has(node.id));
            return (
              <NodeGlyph
                key={node.id}
                node={node}
                selected={node.id === selectedNodeId}
                neighbor={isNeighbor}
                onPath={onPath}
                added={added}
                removed={removed}
                showLabel={showLabels}
                dimmed={
                  Boolean(selectedNodeId) &&
                  node.id !== selectedNodeId &&
                  !isNeighbor &&
                  !onPath &&
                  !added &&
                  !removed
                }
                onSelect={() => onSelectNode(node.id)}
              />
            );
          })}
        </g>
      </svg>

      <div className="graph-a11y-list">
        <label className="sr-only" htmlFor={listId}>
          Select a graph node
        </label>
        <select
          id={listId}
          value={selectedNodeId ?? ''}
          onChange={(e) => onSelectNode(e.target.value || null)}
          aria-label="Graph nodes"
        >
          <option value="">No selection</option>
          {nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.label} ({n.kind}
              {n.path ? `, ${n.path}` : ''})
            </option>
          ))}
        </select>
        {selected ? (
          <span className="graph-a11y-hint" aria-live="polite">
            Selected {selected.label}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function NodeGlyph({
  node,
  selected,
  neighbor,
  onPath,
  added,
  removed,
  dimmed,
  showLabel,
  onSelect,
}: {
  node: GraphNode & { x: number; y: number };
  selected: boolean;
  neighbor: boolean;
  onPath: boolean;
  added: boolean;
  removed: boolean;
  dimmed: boolean;
  showLabel: boolean;
  onSelect: () => void;
}) {
  const shape = KIND_SHAPE[node.kind] ?? 'circle';
  const className = [
    'graph-node',
    `kind-${node.kind}`,
    selected ? 'is-selected' : '',
    neighbor ? 'is-neighbor' : '',
    onPath ? 'is-path' : '',
    added ? 'is-added' : '',
    removed ? 'is-removed' : '',
    dimmed ? 'is-dimmed' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <g
      data-node={node.id}
      className={className}
      transform={`translate(${node.x} ${node.y})`}
      tabIndex={0}
      role="button"
      aria-label={`${node.kind} ${node.label}${selected ? ', selected' : ''}`}
      aria-pressed={selected}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      {shape === 'diamond' ? (
        <polygon points="0,-16 16,0 0,16 -16,0" />
      ) : shape === 'rounded' ? (
        <rect x={-22} y={-14} width={44} height={28} rx={6} />
      ) : (
        <circle r={14} />
      )}
      {showLabel ? (
        <text y={32} textAnchor="middle" className="graph-node-label">
          {node.label}
        </text>
      ) : null}
    </g>
  );
}
