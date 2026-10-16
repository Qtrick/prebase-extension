import { afterEach, describe, expect, it, vi } from 'vitest';

type Handler = (uri: { fsPath: string }) => void;

const handlers: { create: Handler[]; change: Handler[]; delete: Handler[] } = {
  create: [],
  change: [],
  delete: [],
};

vi.mock('vscode', () => ({
  workspace: {
    createFileSystemWatcher: () => {
      handlers.create = [];
      handlers.change = [];
      handlers.delete = [];
      return {
        onDidCreate: (cb: Handler) => {
          handlers.create.push(cb);
          return { dispose: () => undefined };
        },
        onDidChange: (cb: Handler) => {
          handlers.change.push(cb);
          return { dispose: () => undefined };
        },
        onDidDelete: (cb: Handler) => {
          handlers.delete.push(cb);
          return { dispose: () => undefined };
        },
        dispose: () => undefined,
      };
    },
  },
  RelativePattern: class {
    constructor(
      public folder: unknown,
      public pattern: string,
    ) {}
  },
}));

import { WorkspaceGraphWatcher } from './WorkspaceGraphWatcher';

describe('WorkspaceGraphWatcher', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces rapid events into one debounced callback', () => {
    vi.useFakeTimers();
    const onDebouncedChange = vi.fn();
    const watcher = new WorkspaceGraphWatcher({
      folder: { uri: { fsPath: '/ws' }, name: 'ws', index: 0 } as never,
      debounceMs: 100,
      onDebouncedChange,
    });

    handlers.change[0]!({ fsPath: '/ws/src/a.ts' });
    handlers.change[0]!({ fsPath: '/ws/src/a.ts' });
    handlers.create[0]!({ fsPath: '/ws/src/b.ts' });
    expect(onDebouncedChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(onDebouncedChange).toHaveBeenCalledTimes(1);
    const [uris, reasons] = onDebouncedChange.mock.calls[0]!;
    expect(uris).toHaveLength(2);
    expect(reasons.has('change')).toBe(true);
    expect(reasons.has('create')).toBe(true);

    watcher.dispose();
  });

  it('ignores node_modules paths', () => {
    vi.useFakeTimers();
    const onDebouncedChange = vi.fn();
    const watcher = new WorkspaceGraphWatcher({
      folder: { uri: { fsPath: '/ws' }, name: 'ws', index: 0 } as never,
      debounceMs: 50,
      onDebouncedChange,
    });
    handlers.change[0]!({ fsPath: '/ws/node_modules/x/index.js' });
    vi.advanceTimersByTime(50);
    expect(onDebouncedChange).not.toHaveBeenCalled();
    watcher.dispose();
  });

  it('dispose prevents further callbacks', () => {
    vi.useFakeTimers();
    const onDebouncedChange = vi.fn();
    const watcher = new WorkspaceGraphWatcher({
      folder: { uri: { fsPath: '/ws' }, name: 'ws', index: 0 } as never,
      debounceMs: 50,
      onDebouncedChange,
    });
    handlers.change[0]!({ fsPath: '/ws/src/a.ts' });
    watcher.dispose();
    vi.advanceTimersByTime(50);
    expect(onDebouncedChange).not.toHaveBeenCalled();
  });
});
