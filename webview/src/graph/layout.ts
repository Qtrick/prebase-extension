import type { CanonicalGraph, GraphNode } from '@prebase/protocol';

export interface LaidOutNode extends GraphNode {
  x: number;
  y: number;
}

/**
 * Deterministic layered / grid layout.
 * When `previous` positions exist for a node id, reuse them to avoid jitter
 * across incremental graph updates (new nodes get fresh grid slots).
 */
export function layoutGraph(
  graph: CanonicalGraph,
  width: number,
  height: number,
  previous?: Map<string, { x: number; y: number }> | null,
): LaidOutNode[] {
  const padX = 56;
  const padY = 48;
  const nodes = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id));
  if (nodes.length === 0) return [];

  const kinds = new Set(nodes.map((n) => n.kind));
  let laid: LaidOutNode[];
  if (kinds.size === 1 || nodes.every((n) => n.kind === 'file')) {
    laid = gridLayout(nodes, width, height, padX, padY);
  } else {
    laid = layeredLayout(nodes, width, height, padX, padY);
  }

  if (!previous || previous.size === 0) return laid;

  return laid.map((node) => {
    const prev = previous.get(node.id);
    if (!prev) return node;
    return { ...node, x: prev.x, y: prev.y };
  });
}

function layeredLayout(
  nodes: GraphNode[],
  width: number,
  height: number,
  padX: number,
  padY: number,
): LaidOutNode[] {
  const byKind: Record<string, GraphNode[]> = {};
  for (const node of nodes) {
    (byKind[node.kind] ??= []).push(node);
  }
  const layers = ['module', 'folder', 'file', 'component', 'service', 'function'];
  const orderedLayers = layers.filter((k) => (byKind[k]?.length ?? 0) > 0);
  const layerCount = Math.max(orderedLayers.length, 1);
  const result: LaidOutNode[] = [];

  orderedLayers.forEach((kind, layerIndex) => {
    const layerNodes = byKind[kind] ?? [];
    const y =
      padY +
      (layerCount === 1
        ? (height - padY * 2) / 2
        : (layerIndex / (layerCount - 1)) * (height - padY * 2));
    layerNodes.forEach((node, i) => {
      const x =
        layerNodes.length === 1
          ? width / 2
          : padX + (i / (layerNodes.length - 1)) * (width - padX * 2);
      result.push({ ...node, x, y });
    });
  });

  return result;
}

function gridLayout(
  nodes: GraphNode[],
  width: number,
  height: number,
  padX: number,
  padY: number,
): LaidOutNode[] {
  const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  const rows = Math.max(1, Math.ceil(nodes.length / cols));
  const cellW = (width - padX * 2) / Math.max(cols - 1, 1);
  const cellH = (height - padY * 2) / Math.max(rows - 1, 1);

  return nodes.map((node, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = cols === 1 ? width / 2 : padX + col * cellW;
    const y = rows === 1 ? height / 2 : padY + row * cellH;
    return { ...node, x, y };
  });
}
