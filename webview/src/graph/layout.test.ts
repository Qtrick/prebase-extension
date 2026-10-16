import { describe, expect, it } from 'vitest';
import type { CanonicalGraph } from '@prebase/protocol';
import { layoutGraph } from './layout';

const graph: CanonicalGraph = {
  nodes: [
    { id: 'b', kind: 'file', label: 'b' },
    { id: 'a', kind: 'module', label: 'a' },
  ],
  edges: [],
  projectPath: '/',
  projectName: 't',
  entryNodeId: null,
  revision: 'r',
  provenance: 'fixture',
  versions: { graphSchemaVersion: 1, analyzerVersion: 1, identityVersion: 1 },
};

describe('layoutGraph', () => {
  it('assigns stable positions from ids', () => {
    const a = layoutGraph(graph, 400, 300);
    const b = layoutGraph(graph, 400, 300);
    expect(a.map((n) => n.id)).toEqual(b.map((n) => n.id));
    expect(a[0].x).toBe(b[0].x);
    expect(a.find((n) => n.id === 'a')?.y).toBeLessThan(
      a.find((n) => n.id === 'b')?.y ?? Infinity,
    );
  });
});
