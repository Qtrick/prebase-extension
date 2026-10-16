import type { CanonicalGraph, GraphEdge, GraphNode } from '@prebase/protocol';

export interface GraphProjection {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type EdgeEmphasis = 'both' | 'outgoing' | 'incoming' | 'none';

export function projectGraph(
  graph: CanonicalGraph,
  options: {
    query: string;
    language: string;
    connectedOnly: boolean;
    /** When set, show selected node + 1-hop neighbors only (canonical graph unchanged). */
    neighborhoodOf?: string | null;
    /** When set with neighborhoodOf, include a directed path highlight set of node ids. */
    pathNodeIds?: Set<string> | null;
  },
): GraphProjection {
  const q = options.query.trim().toLowerCase();
  let nodes = graph.nodes;

  if (options.neighborhoodOf) {
    const focus = options.neighborhoodOf;
    const keep = new Set<string>([focus]);
    for (const e of graph.edges) {
      if (e.source === focus) keep.add(e.target);
      if (e.target === focus) keep.add(e.source);
    }
    if (options.pathNodeIds) {
      for (const id of options.pathNodeIds) keep.add(id);
    }
    nodes = nodes.filter((n) => keep.has(n.id));
  }

  if (options.language) {
    nodes = nodes.filter((n) => (n.language ?? '') === options.language);
  }

  if (q) {
    nodes = nodes.filter(
      (n) =>
        n.label.toLowerCase().includes(q) ||
        (n.path ?? '').toLowerCase().includes(q) ||
        n.id.toLowerCase().includes(q),
    );
  }

  if (options.connectedOnly) {
    const connected = new Set<string>();
    for (const e of graph.edges) {
      connected.add(e.source);
      connected.add(e.target);
    }
    nodes = nodes.filter((n) => connected.has(n.id));
  }

  const ids = new Set(nodes.map((n) => n.id));
  const edges = graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  return { nodes, edges };
}

export function neighborIds(
  graph: CanonicalGraph,
  nodeId: string | null,
): { incoming: Set<string>; outgoing: Set<string> } {
  const incoming = new Set<string>();
  const outgoing = new Set<string>();
  if (!nodeId) return { incoming, outgoing };
  for (const e of graph.edges) {
    if (e.source === nodeId) outgoing.add(e.target);
    if (e.target === nodeId) incoming.add(e.source);
  }
  return { incoming, outgoing };
}

export function languagesInGraph(graph: CanonicalGraph): string[] {
  const set = new Set<string>();
  for (const n of graph.nodes) {
    if (n.language) set.add(n.language);
  }
  return [...set].sort();
}

export function degreeOf(graph: CanonicalGraph, nodeId: string): {
  inDegree: number;
  outDegree: number;
} {
  let inDegree = 0;
  let outDegree = 0;
  for (const e of graph.edges) {
    if (e.source === nodeId) outDegree += 1;
    if (e.target === nodeId) inDegree += 1;
  }
  return { inDegree, outDegree };
}

/**
 * Shortest directed dependency path over import/dependency/reference edges.
 * BFS with deterministic queue order (edge id tie-break via adjacency sort).
 * Returns null when no path exists. Metric is hop count, not architectural importance.
 */
/** Stable key for a directed edge pair (matches graph edge source/target). */
export function pathEdgePairKey(source: string, target: string): string {
  return `${source}\0${target}`;
}

/** Consecutive hop pairs along a dependency path (not all pairs of nodes on the path). */
export function pathEdgeKeysFromPath(path: string[]): Set<string> {
  const keys = new Set<string>();
  for (let i = 0; i + 1 < path.length; i++) {
    keys.add(pathEdgePairKey(path[i]!, path[i + 1]!));
  }
  return keys;
}

export function findDependencyPath(
  graph: CanonicalGraph,
  fromId: string,
  toId: string,
): string[] | null {
  if (fromId === toId) return [fromId];
  const adj = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (
      e.kind !== 'import' &&
      e.kind !== 'dependency' &&
      e.kind !== 'reference'
    ) {
      continue;
    }
    const list = adj.get(e.source) ?? [];
    list.push(e.target);
    adj.set(e.source, list);
  }
  for (const [, targets] of adj) {
    targets.sort((a, b) => a.localeCompare(b));
  }

  const queue: string[] = [fromId];
  const prev = new Map<string, string | null>([[fromId, null]]);
  let head = 0;
  const limit = Math.max(graph.nodes.length * 4, 64);

  while (head < queue.length && head < limit) {
    const cur = queue[head++]!;
    const nexts = adj.get(cur) ?? [];
    for (const n of nexts) {
      if (prev.has(n)) continue;
      prev.set(n, cur);
      if (n === toId) {
        const path: string[] = [];
        let walk: string | null = toId;
        while (walk) {
          path.push(walk);
          walk = prev.get(walk) ?? null;
        }
        path.reverse();
        return path;
      }
      queue.push(n);
    }
  }
  return null;
}

export function connectedComponents(graph: CanonicalGraph): string[][] {
  const undirected = new Map<string, Set<string>>();
  for (const n of graph.nodes) {
    undirected.set(n.id, new Set());
  }
  for (const e of graph.edges) {
    undirected.get(e.source)?.add(e.target);
    undirected.get(e.target)?.add(e.source);
  }
  const seen = new Set<string>();
  const components: string[][] = [];
  for (const n of graph.nodes) {
    if (seen.has(n.id)) continue;
    const stack = [n.id];
    const comp: string[] = [];
    seen.add(n.id);
    while (stack.length) {
      const id = stack.pop()!;
      comp.push(id);
      for (const next of undirected.get(id) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    comp.sort((a, b) => a.localeCompare(b));
    components.push(comp);
  }
  components.sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!));
  return components;
}
