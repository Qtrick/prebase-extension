import { describe, expect, it } from 'vitest';
import type { CanonicalGraph } from '@prebase/protocol';
import {
  connectedComponents,
  findDependencyPath,
  languagesInGraph,
  neighborIds,
  projectGraph,
} from './projectGraph';

const graph: CanonicalGraph = {
  nodes: [
    { id: 'file:a.ts', kind: 'file', label: 'a.ts', path: 'src/a.ts', language: 'typescript' },
    { id: 'file:b.ts', kind: 'file', label: 'b.ts', path: 'src/b.ts', language: 'typescript' },
    { id: 'file:c.rs', kind: 'file', label: 'c.rs', path: 'src/c.rs', language: 'rust' },
  ],
  edges: [
    {
      id: 'e1',
      source: 'file:a.ts',
      target: 'file:b.ts',
      kind: 'import',
      resolution: 'resolved',
    },
  ],
  projectPath: '/',
  projectName: 't',
  entryNodeId: null,
  revision: 'r',
  provenance: 'repository',
  versions: { graphSchemaVersion: 1, analyzerVersion: 2, identityVersion: 1 },
};

describe('projectGraph', () => {
  it('filters by language and connected-only without mutating source', () => {
    const projected = projectGraph(graph, {
      query: '',
      language: 'typescript',
      connectedOnly: true,
    });
    expect(projected.nodes.map((n) => n.id)).toEqual(['file:a.ts', 'file:b.ts']);
    expect(graph.nodes).toHaveLength(3);
  });

  it('search matches path', () => {
    const projected = projectGraph(graph, {
      query: 'c.rs',
      language: '',
      connectedOnly: false,
    });
    expect(projected.nodes).toHaveLength(1);
    expect(projected.nodes[0]?.id).toBe('file:c.rs');
  });

  it('search is case-insensitive and matches label or id', () => {
    const byLabel = projectGraph(graph, {
      query: 'B.TS',
      language: '',
      connectedOnly: false,
    });
    expect(byLabel.nodes.map((n) => n.id)).toEqual(['file:b.ts']);

    const byId = projectGraph(graph, {
      query: 'file:a',
      language: '',
      connectedOnly: false,
    });
    expect(byId.nodes.map((n) => n.id)).toEqual(['file:a.ts']);
  });

  it('connected-only drops isolated nodes even when language filter matches', () => {
    const projected = projectGraph(graph, {
      query: '',
      language: 'rust',
      connectedOnly: true,
    });
    expect(projected.nodes).toHaveLength(0);
    expect(projected.edges).toHaveLength(0);
  });

  it('keeps only edges whose endpoints survive filtering', () => {
    const projected = projectGraph(graph, {
      query: '',
      language: 'typescript',
      connectedOnly: false,
    });
    expect(projected.nodes).toHaveLength(2);
    expect(projected.edges).toHaveLength(1);
    expect(projected.edges[0]?.source).toBe('file:a.ts');
  });
});

describe('neighborIds', () => {
  it('returns incoming and outgoing neighbors', () => {
    const n = neighborIds(graph, 'file:b.ts');
    expect([...n.incoming]).toEqual(['file:a.ts']);
    expect([...n.outgoing]).toEqual([]);
  });
});

describe('languagesInGraph', () => {
  it('lists unique languages', () => {
    expect(languagesInGraph(graph)).toEqual(['rust', 'typescript']);
  });
});

describe('neighborhood projection', () => {
  it('limits to selected node and neighbors without mutating canonical graph', () => {
    const projected = projectGraph(graph, {
      query: '',
      language: '',
      connectedOnly: false,
      neighborhoodOf: 'file:a.ts',
    });
    expect(projected.nodes.map((n) => n.id).sort()).toEqual([
      'file:a.ts',
      'file:b.ts',
    ]);
    expect(graph.nodes).toHaveLength(3);
  });
});

describe('findDependencyPath', () => {
  it('finds a directed hop path', () => {
    expect(findDependencyPath(graph, 'file:a.ts', 'file:b.ts')).toEqual([
      'file:a.ts',
      'file:b.ts',
    ]);
  });

  it('returns null when no path exists', () => {
    expect(findDependencyPath(graph, 'file:b.ts', 'file:a.ts')).toBeNull();
  });
});

describe('connectedComponents', () => {
  it('groups connected nodes', () => {
    const comps = connectedComponents(graph);
    expect(comps[0]).toEqual(['file:a.ts', 'file:b.ts']);
    expect(comps.some((c) => c.includes('file:c.rs'))).toBe(true);
  });
});
