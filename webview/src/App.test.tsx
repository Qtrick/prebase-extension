import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalGraph, HostToWebview } from '@prebase/protocol';
import { App } from './App';

const posts: unknown[] = [];

vi.mock('./bridge/vscodeApi', () => ({
  postToHost: (msg: unknown) => {
    posts.push(msg);
  },
  getVsCodeApi: () => ({
    postMessage: (msg: unknown) => posts.push(msg),
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

function sampleGraph(): CanonicalGraph {
  return {
    nodes: [
      {
        id: 'mod:app',
        kind: 'module',
        label: 'app',
        path: 'src',
      },
      {
        id: 'file:a.ts',
        kind: 'file',
        label: 'a.ts',
        path: 'src/a.ts',
        language: 'typescript',
      },
    ],
    edges: [
      {
        id: 'e1',
        source: 'mod:app',
        target: 'file:a.ts',
        kind: 'contains',
      },
    ],
    projectPath: '/tmp/ws',
    projectName: 'ws',
    entryNodeId: 'mod:app',
    revision: 'fixture-v1',
    provenance: 'fixture',
    versions: {
      graphSchemaVersion: 1,
      analyzerVersion: 1,
      identityVersion: 1,
    },
    provenanceNote: 'Sample architecture graph.',
  };
}

function emit(msg: HostToWebview): void {
  window.dispatchEvent(new MessageEvent('message', { data: msg }));
}

describe('App', () => {
  beforeEach(() => {
    posts.length = 0;
  });

  afterEach(() => {
    cleanup();
  });

  it('posts ready on mount and shows loading', async () => {
    render(<App />);
    await waitFor(() => {
      expect(posts).toContainEqual({ type: 'ready' });
    });
    expect(screen.getAllByRole('status')[0]).toHaveTextContent(/Initializing PreBase/i);
  });

  it('filters projected graph via search, language, and connected-only', async () => {
    const user = userEvent.setup();
    render(<App />);
    emit({
      type: 'graph',
      graph: {
        ...sampleGraph(),
        nodes: [
          {
            id: 'file:a.ts',
            kind: 'file',
            label: 'a.ts',
            path: 'src/a.ts',
            language: 'typescript',
          },
          {
            id: 'file:b.ts',
            kind: 'file',
            label: 'b.ts',
            path: 'src/b.ts',
            language: 'typescript',
          },
          {
            id: 'file:orphan.rs',
            kind: 'file',
            label: 'orphan.rs',
            path: 'src/orphan.rs',
            language: 'rust',
          },
        ],
        edges: [
          {
            id: 'e1',
            source: 'file:a.ts',
            target: 'file:b.ts',
            kind: 'import',
          },
        ],
      },
      status: 'graph_ready',
      message: 'Ready.',
    });

    expect(
      await screen.findByRole('img', { name: /Network graph with 3 nodes/i }),
    ).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Filter by language'), 'rust');
    expect(
      screen.getByRole('img', { name: /Network graph with 1 nodes/i }),
    ).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Filter by language'), '');
    await user.type(screen.getByLabelText('Search graph nodes'), 'nomatch');
    expect(screen.getByText(/No matching nodes/i)).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'No matches' }),
    ).toBeInTheDocument();

    await user.clear(screen.getByLabelText('Search graph nodes'));
    await user.click(screen.getByRole('checkbox', { name: /Connected only/i }));
    expect(
      screen.getByRole('img', { name: /Network graph with 2 nodes/i }),
    ).toBeInTheDocument();
  });

  it('shows analysis coverage in the inspector for repository graphs', async () => {
    render(<App />);
    emit({
      type: 'graph',
      graph: {
        ...sampleGraph(),
        provenance: 'repository',
        provenanceNote: undefined,
        coverage: {
          discoveredFiles: 5,
          analyzedFiles: 4,
          unsupportedFiles: 1,
          parseFailures: 0,
          resolvedImports: 2,
          unresolvedImports: 1,
          externalImports: 0,
          ambiguousImports: 0,
          excludedPaths: 0,
          durationMs: 99,
        },
      },
      status: 'graph_ready',
      message: 'Analyzed workspace.',
    });

    const coverage = await screen.findByLabelText('Analysis coverage');
    expect(within(coverage).getByText('4/5')).toBeInTheDocument();
    expect(within(coverage).getByText('99ms')).toBeInTheDocument();
  });

  it('renders graph, selection, and inspector metadata', async () => {
    const user = userEvent.setup();
    render(<App />);
    emit({
      type: 'graph',
      graph: sampleGraph(),
      status: 'graph_ready',
      message: 'Sample architecture graph.',
    });

    expect(await screen.findByRole('note')).toHaveTextContent(/Sample architecture/i);
    expect(
      screen.getAllByRole('img', { name: /Network graph with 2 nodes/i })[0],
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Search graph nodes')).toBeInTheDocument();

    const select = screen.getByLabelText('Graph nodes');
    await user.selectOptions(select, 'file:a.ts');

    expect(screen.getByText('a.ts', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByText('file', { selector: '.kind-badge' })).toBeInTheDocument();
    expect(posts).toContainEqual({ type: 'selectNode', nodeId: 'file:a.ts' });
  });

  it('switches to temporal entry point', async () => {
    const user = userEvent.setup();
    render(<App />);
    const tabs = screen.getByRole('navigation', { name: 'Graph views' });
    await user.click(within(tabs).getByRole('button', { name: 'Temporal' }));
    expect(screen.getByRole('region', { name: /Temporal graph/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Index history/i })).toBeInTheDocument();
    expect(posts).toContainEqual({ type: 'setView', view: 'temporal' });
  });

  it('renders temporal timeline from host and posts temporalIndex on index', async () => {
    const user = userEvent.setup();
    render(<App />);
    const tabs = screen.getByRole('navigation', { name: 'Graph views' });
    await user.click(within(tabs).getByRole('button', { name: 'Temporal' }));

    emit({
      type: 'temporalTimeline',
      timeline: [
        {
          commit: {
            oid: 'abcd1234abcd1234abcd1234abcd1234abcd1234',
            parents: [],
            summary: 'feat: add billing module',
            author: 'PreBase',
            timeSeconds: 1_700_000_000,
          },
          status: 'complete',
          digest: 'digest-a',
        },
        {
          commit: {
            oid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            parents: ['abcd1234abcd1234abcd1234abcd1234abcd1234'],
            summary: 'chore: initial scaffold',
            author: 'PreBase',
            timeSeconds: 1_699_000_000,
          },
          status: 'pending',
        },
      ],
      isShallow: false,
      note: 'First-parent history only.',
    });

    const timeline = await screen.findByRole('complementary', {
      name: /Architecture history timeline/i,
    });
    expect(within(timeline).getByText('feat: add billing module')).toBeInTheDocument();
    expect(within(timeline).getByText('chore: initial scaffold')).toBeInTheDocument();

    posts.length = 0;
    await user.click(screen.getByRole('button', { name: /Index history/i }));
    expect(posts).toContainEqual({ type: 'temporalIndex', limit: 40 });
  });

  it('shows empty graph state when host reports empty_graph', async () => {
    render(<App />);
    emit({
      type: 'graph',
      graph: {
        ...sampleGraph(),
        nodes: [],
        edges: [],
      },
      status: 'empty_graph',
      message: 'No nodes were returned for this workspace.',
    });

    const emptyPanel = await screen.findByRole('heading', { name: 'Empty graph' });
    expect(emptyPanel.closest('.empty-panel')).toHaveTextContent(/No supported source files/i);
    expect(screen.queryByRole('img', { name: /Network graph/i })).not.toBeInTheDocument();
  });

  it('shows fixture provenance note in the banner', async () => {
    render(<App />);
    emit({
      type: 'graph',
      graph: sampleGraph(),
      status: 'graph_ready',
      message: 'Sample architecture graph.',
    });

    expect(await screen.findByRole('note')).toHaveTextContent(/Sample architecture/i);
    expect(screen.getByRole('note')).toHaveTextContent(/Sample architecture graph/i);
  });

  it('ignores malformed host messages without updating the graph', async () => {
    render(<App />);
    emit({
      type: 'graph',
      graph: sampleGraph(),
      status: 'graph_ready',
      message: 'Sample architecture graph.',
    });
    expect(await screen.findByRole('note')).toHaveTextContent(/Sample architecture/i);

    window.dispatchEvent(new MessageEvent('message', { data: { type: 'graph', graph: { nodes: [] } } }));
    window.dispatchEvent(new MessageEvent('message', { data: null }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'status' } }));

    expect(screen.getByRole('note')).toHaveTextContent(/Sample architecture/i);
    expect(
      screen.getAllByRole('img', { name: /Network graph with 2 nodes/i })[0],
    ).toBeInTheDocument();
  });

  it('recovers from error via retry', async () => {
    const user = userEvent.setup();
    render(<App />);
    emit({
      type: 'error',
      category: 'engine_not_ready',
      message: 'Engine process exited unexpectedly',
      recoverable: true,
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(/exited unexpectedly/i);
    const retryButtons = screen.getAllByRole('button', { name: 'Retry' });
    await user.click(retryButtons[0]!);
    expect(posts).toContainEqual({ type: 'retry' });
  });

  it('neighborhood focus limits visible nodes to selected node and neighbors', async () => {
    const user = userEvent.setup();
    render(<App />);
    emit({
      type: 'graph',
      graph: {
        ...sampleGraph(),
        nodes: [
          {
            id: 'file:a.ts',
            kind: 'file',
            label: 'a.ts',
            path: 'src/a.ts',
            language: 'typescript',
          },
          {
            id: 'file:b.ts',
            kind: 'file',
            label: 'b.ts',
            path: 'src/b.ts',
            language: 'typescript',
          },
          {
            id: 'file:orphan.ts',
            kind: 'file',
            label: 'orphan.ts',
            path: 'src/orphan.ts',
            language: 'typescript',
          },
        ],
        edges: [
          {
            id: 'e1',
            source: 'file:a.ts',
            target: 'file:b.ts',
            kind: 'import',
          },
        ],
      },
      status: 'graph_ready',
      message: 'Ready.',
    });

    expect(
      await screen.findByRole('img', { name: /Network graph with 3 nodes/i }),
    ).toBeInTheDocument();

    const select = screen.getByLabelText('Graph nodes');
    await user.selectOptions(select, 'file:a.ts');
    await user.click(screen.getByRole('checkbox', { name: /Neighborhood/i }));

    expect(
      screen.getByRole('img', { name: /Network graph with 2 nodes/i }),
    ).toBeInTheDocument();
  });

  it('shows no-path message when dependency path does not exist', async () => {
    const user = userEvent.setup();
    render(<App />);
    emit({
      type: 'graph',
      graph: {
        ...sampleGraph(),
        nodes: [
          {
            id: 'file:a.ts',
            kind: 'file',
            label: 'a.ts',
            path: 'src/a.ts',
            language: 'typescript',
          },
          {
            id: 'file:b.ts',
            kind: 'file',
            label: 'b.ts',
            path: 'src/b.ts',
            language: 'typescript',
          },
          {
            id: 'file:c.ts',
            kind: 'file',
            label: 'c.ts',
            path: 'src/c.ts',
            language: 'typescript',
          },
        ],
        edges: [
          {
            id: 'e1',
            source: 'file:a.ts',
            target: 'file:b.ts',
            kind: 'import',
          },
        ],
      },
      status: 'graph_ready',
      message: 'Ready.',
    });

    expect(
      await screen.findByRole('img', { name: /Network graph with 3 nodes/i }),
    ).toBeInTheDocument();

    const select = screen.getByLabelText('Graph nodes');
    await user.selectOptions(select, 'file:a.ts');
    await user.selectOptions(screen.getByLabelText('Path destination node'), 'file:c.ts');

    expect(
      await screen.findByText('No directed dependency path to that node.'),
    ).toBeInTheDocument();
  });

  it('clears selection when an updated graph omits the selected node', async () => {
    const user = userEvent.setup();
    render(<App />);
    emit({
      type: 'graph',
      graph: sampleGraph(),
      status: 'graph_ready',
      message: 'Ready.',
    });

    expect(
      await screen.findByRole('img', { name: /Network graph with 2 nodes/i }),
    ).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Graph nodes'), 'file:a.ts');
    expect(screen.getByText('a.ts', { selector: 'dd' })).toBeInTheDocument();

    emit({
      type: 'graph',
      graph: {
        ...sampleGraph(),
        nodes: [
          {
            id: 'mod:app',
            kind: 'module',
            label: 'app',
            path: 'src',
          },
        ],
        edges: [],
      },
      status: 'graph_ready',
      message: 'Updated.',
    });

    expect(
      await screen.findByText('Select a node to inspect metadata and dependencies.'),
    ).toBeInTheDocument();
  });

  it('shows updating chip while graph is visible and status is updating_graph', async () => {
    render(<App />);
    emit({
      type: 'graph',
      graph: sampleGraph(),
      status: 'graph_ready',
      message: 'Ready.',
    });
    expect(
      await screen.findByRole('img', { name: /Network graph with 2 nodes/i }),
    ).toBeInTheDocument();

    emit({
      type: 'status',
      status: 'updating_graph',
      message: 'Refreshing graph…',
    });

    expect(await screen.findByText('Updating…')).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: /Network graph with 2 nodes/i }),
    ).toBeInTheDocument();
  });
});
