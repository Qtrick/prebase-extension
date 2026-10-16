import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalGraph } from '../../../shared/protocol/src/index';
import { EngineClient, EngineClientError } from './EngineClient';

const spawnMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

type EngineReq = { id: string; method: string; params: unknown };

function graphTagged(projectName: string, projectPath: string): CanonicalGraph {
  return {
    nodes: [{ id: 'n1', kind: 'module', label: projectName, path: 'src' }],
    edges: [],
    projectPath,
    projectName,
    entryNodeId: 'n1',
    revision: 'fixture-v1',
    provenance: 'fixture',
    versions: {
      graphSchemaVersion: 1,
      analyzerVersion: 1,
      identityVersion: 1,
    },
  };
}

function installMockEngine(
  onRequest?: (req: EngineReq) => unknown | { error: { category: string; message: string } },
) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    killed: false,
    kill: vi.fn(),
  });

  stdin.on('data', (buf: Buffer) => {
    for (const line of buf.toString().split('\n').filter((l) => l.trim())) {
      const req = JSON.parse(line) as EngineReq;
      const custom = onRequest?.(req);
      if (custom && 'error' in (custom as object)) {
        stdout.write(`${JSON.stringify({ protocolVersion: 1, id: req.id, ...custom })}\n`);
        continue;
      }
      const result =
        custom ??
        (req.method === 'initialize'
          ? {
              engineVersion: 'test',
              protocolVersion: 1,
              capabilities: {
                networkGraph: true,
                temporalGraph: true,
                fixtureGraph: true,
              },
            }
          : req.method === 'getNetworkGraph'
            ? {
                graph: graphTagged(
                  req.id,
                  (req.params as { workspacePath: string }).workspacePath,
                ),
              }
            : req.method === 'shutdown'
              ? { ok: true }
              : { ok: true });
      stdout.write(
        `${JSON.stringify({ protocolVersion: 1, id: req.id, result })}\n`,
      );
    }
  });

  spawnMock.mockReturnValue(child);
  return { child, stdout, stderr, stdin };
}

describe('EngineClient stdio handling', () => {
  let extDir: string;
  const logs: string[] = [];

  beforeEach(() => {
    logs.length = 0;
    spawnMock.mockReset();
    extDir = mkdtempSync(join(tmpdir(), 'prebase-ext-'));
    const binDir = join(extDir, 'bin');
    mkdirSync(binDir);
    const name = process.platform === 'win32' ? 'prebase-engine.exe' : 'prebase-engine';
    const binPath = join(binDir, name);
    writeFileSync(binPath, '');
    if (process.platform !== 'win32') {
      chmodSync(binPath, 0o755);
    }
  });

  it('correlates stdout responses to the matching pending request id', async () => {
    installMockEngine();
    const client = new EngineClient(extDir, (m) => logs.push(m));
    await client.start();

    const [first, second] = await Promise.all([
      client.getNetworkGraph('/tmp/ws-a'),
      client.getNetworkGraph('/tmp/ws-b'),
    ]);

    expect(first.graph.projectName).toBe('2');
    expect(second.graph.projectName).toBe('3');
    await client.shutdown();
  });

  it('ignores malformed stdout lines without settling pending requests', async () => {
    const { stdout } = installMockEngine();
    const client = new EngineClient(extDir, (m) => logs.push(m));
    await client.start();

    stdout.write('{not-json\n');
    expect(logs.some((l) => l.includes('Ignoring malformed engine line'))).toBe(true);

    const result = await client.getNetworkGraph('/tmp/ws');
    expect(result.graph.projectName).toBe('2');
    await client.shutdown();
  });

  it('ignores responses for unknown request ids', async () => {
    const { stdout } = installMockEngine();
    const client = new EngineClient(extDir, (m) => logs.push(m));
    await client.start();

    stdout.write(
      `${JSON.stringify({
        protocolVersion: 1,
        id: 'orphan',
        result: { ok: true },
      })}\n`,
    );
    expect(logs.some((l) => l.includes('No pending request for id=orphan'))).toBe(true);

    const result = await client.getNetworkGraph('/tmp/ws');
    expect(result.graph.nodes).toHaveLength(1);
    await client.shutdown();
  });

  it('sends preferFixture true only when explicitly requested', async () => {
    const captured: Array<{ preferFixture?: boolean }> = [];
    installMockEngine((req) => {
      if (req.method === 'getNetworkGraph') {
        captured.push(req.params as { preferFixture?: boolean });
      }
      return undefined;
    });
    const client = new EngineClient(extDir, () => undefined);
    await client.start();

    await client.getNetworkGraph('/tmp/ws-default');
    await client.getNetworkGraph('/tmp/ws-fixture', { preferFixture: true });
    await client.getNetworkGraph('/tmp/ws-false', { preferFixture: false });

    expect(captured.map((p) => p.preferFixture)).toEqual([false, true, false]);
    await client.shutdown();
  });

  it('sends forceRefresh true only when explicitly requested', async () => {
    const captured: Array<{ forceRefresh?: boolean }> = [];
    installMockEngine((req) => {
      if (req.method === 'getNetworkGraph') {
        captured.push(req.params as { forceRefresh?: boolean });
      }
      return undefined;
    });
    const client = new EngineClient(extDir, () => undefined);
    await client.start();

    await client.getNetworkGraph('/tmp/ws-default');
    await client.getNetworkGraph('/tmp/ws-refresh', { forceRefresh: true });
    await client.getNetworkGraph('/tmp/ws-false', { forceRefresh: false });

    expect(captured.map((p) => p.forceRefresh)).toEqual([false, true, false]);
    await client.shutdown();
  });

  it('surfaces engine unsupported_version errors on requests', async () => {
    installMockEngine((req) => {
      if (req.method === 'getNetworkGraph') {
        return {
          error: {
            category: 'unsupported_version',
            message: 'Unsupported protocol version 2',
          },
        };
      }
      return undefined;
    });
    const client = new EngineClient(extDir, () => undefined);
    await client.start();

    await expect(client.getNetworkGraph('/tmp/ws')).rejects.toMatchObject({
      message: 'Unsupported protocol version 2',
    } satisfies Partial<EngineClientError>);

    await client.shutdown();
  });

  it('settles out-of-order responses to the matching request ids', async () => {
    const held: EngineReq[] = [];
    const { stdout } = installDeferredEngine(held);

    const client = new EngineClient(extDir, () => undefined);
    await client.start();
    held.length = 0;

    const pSlow = client.getNetworkGraph('/tmp/ws-slow');
    const pFast = client.getNetworkGraph('/tmp/ws-fast');
    await vi.waitFor(() => expect(held.length).toBe(2));

    const [slowReq, fastReq] = held;
    // Answer the second request first (out of order).
    stdout.write(
      `${JSON.stringify({
        protocolVersion: 1,
        id: fastReq.id,
        result: { graph: graphTagged('fast', '/tmp/ws-fast') },
      })}\n`,
    );
    stdout.write(
      `${JSON.stringify({
        protocolVersion: 1,
        id: slowReq.id,
        result: { graph: graphTagged('slow', '/tmp/ws-slow') },
      })}\n`,
    );

    const [slow, fast] = await Promise.all([pSlow, pFast]);
    expect(slow.graph.projectName).toBe('slow');
    expect(fast.graph.projectName).toBe('fast');
    await client.shutdown();
  });

  it('ignores a late response after the request timed out', async () => {
    vi.useFakeTimers();
    const held: EngineReq[] = [];
    const { stdout } = installDeferredEngine(held);
    const lateLogs: string[] = [];
    const client = new EngineClient(extDir, (m) => lateLogs.push(m));

    try {
      await client.start();
      held.length = 0;

      const timedOut = client.getNetworkGraph('/tmp/ws-timeout', { timeoutMs: 40 });
      expect(held).toHaveLength(1);
      const timedOutId = held[0].id;

      const rejection = expect(timedOut).rejects.toMatchObject({
        message: expect.stringMatching(/timed out/i),
        category: 'timeout',
      });
      await vi.advanceTimersByTimeAsync(40);
      await rejection;

      // Late response for the timed-out id must not poison the next request.
      stdout.write(
        `${JSON.stringify({
          protocolVersion: 1,
          id: timedOutId,
          result: { graph: graphTagged('stale', '/tmp/ws-timeout') },
        })}\n`,
      );
      expect(lateLogs.some((l) => l.includes(`No pending request for id=${timedOutId}`))).toBe(
        true,
      );

      held.length = 0;
      const next = client.getNetworkGraph('/tmp/ws-next', { timeoutMs: 2_000 });
      expect(held).toHaveLength(1);
      stdout.write(
        `${JSON.stringify({
          protocolVersion: 1,
          id: held[0].id,
          result: { graph: graphTagged('fresh', '/tmp/ws-next') },
        })}\n`,
      );
      const result = await next;
      expect(result.graph.projectName).toBe('fresh');
    } finally {
      await client.shutdown();
      vi.useRealTimers();
    }
  });

  it('times out only the slow request while a sibling still correlates by id', async () => {
    vi.useFakeTimers();
    const held: EngineReq[] = [];
    const { stdout } = installDeferredEngine(held);
    const client = new EngineClient(extDir, () => undefined);

    try {
      await client.start();
      held.length = 0;

      const slow = client.getNetworkGraph('/tmp/ws-slow', { timeoutMs: 50 });
      const fast = client.getNetworkGraph('/tmp/ws-fast', { timeoutMs: 2_000 });
      expect(held).toHaveLength(2);
      const [slowReq, fastReq] = held;

      stdout.write(
        `${JSON.stringify({
          protocolVersion: 1,
          id: fastReq.id,
          result: { graph: graphTagged('fast', '/tmp/ws-fast') },
        })}\n`,
      );
      await expect(fast).resolves.toMatchObject({ graph: { projectName: 'fast' } });

      const slowRejection = expect(slow).rejects.toMatchObject({
        category: 'timeout',
        message: expect.stringMatching(/timed out/i),
      });
      await vi.advanceTimersByTimeAsync(50);
      await slowRejection;

      // Stale response for the timed-out sibling must not settle against anything else.
      stdout.write(
        `${JSON.stringify({
          protocolVersion: 1,
          id: slowReq.id,
          result: { graph: graphTagged('too-late', '/tmp/ws-slow') },
        })}\n`,
      );
    } finally {
      await client.shutdown();
      vi.useRealTimers();
    }
  });

  it('rejects all in-flight requests when the engine process exits', async () => {
    const held: EngineReq[] = [];
    const { child } = installDeferredEngine(held);
    const client = new EngineClient(extDir, () => undefined);
    await client.start();
    held.length = 0;

    const pending = client.getNetworkGraph('/tmp/ws-exit', { timeoutMs: 5_000 });
    await vi.waitFor(() => expect(held.length).toBe(1));

    child.emit('exit', 1, null);
    await expect(pending).rejects.toMatchObject({
      category: 'engine_not_ready',
      message: expect.stringMatching(/exited unexpectedly/i),
    });
    expect(client.isReady).toBe(false);
  });

  it('ignores exit from a superseded engine process after restart', async () => {
    const first = installDeferredEngine([]);
    const client = new EngineClient(extDir, () => undefined);
    await client.start();
    const oldChild = first.child;

    const secondHeld: EngineReq[] = [];
    const second = installDeferredEngine(secondHeld);
    await client.start();
    expect(client.isReady).toBe(true);

    // Late exit from the replaced child must not clear the active process.
    oldChild.emit('exit', 0, null);
    expect(client.isReady).toBe(true);

    secondHeld.length = 0;
    const pending = client.getNetworkGraph('/tmp/ws-alive', { timeoutMs: 2_000 });
    await vi.waitFor(() => expect(secondHeld.length).toBe(1));
    second.stdout.write(
      `${JSON.stringify({
        protocolVersion: 1,
        id: secondHeld[0].id,
        result: { graph: graphTagged('alive', '/tmp/ws-alive') },
      })}\n`,
    );
    await expect(pending).resolves.toMatchObject({ graph: { projectName: 'alive' } });
    await client.shutdown();
  });

  it('dedupes concurrent start() into a single initialize', async () => {
    let initializeCount = 0;
    installMockEngine((req) => {
      if (req.method === 'initialize') {
        initializeCount += 1;
      }
      return undefined;
    });
    const client = new EngineClient(extDir, () => undefined);
    const [a, b] = await Promise.all([client.start(), client.start()]);
    expect(a.engineVersion).toBe('test');
    expect(b.engineVersion).toBe('test');
    expect(initializeCount).toBe(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await client.shutdown();
  });

  it('does not settle a pending request when a different id responds', async () => {
    const held: EngineReq[] = [];
    const { stdout } = installDeferredEngine(held);
    const logs: string[] = [];
    const client = new EngineClient(extDir, (m) => logs.push(m));
    await client.start();
    held.length = 0;

    const pending = client.getNetworkGraph('/tmp/ws-mismatch', { timeoutMs: 2_000 });
    await vi.waitFor(() => expect(held.length).toBe(1));
    const realId = held[0].id;

    stdout.write(
      `${JSON.stringify({
        protocolVersion: 1,
        id: 'not-the-pending-id',
        result: { graph: graphTagged('wrong', '/tmp/ws-mismatch') },
      })}\n`,
    );
    expect(logs.some((l) => l.includes('No pending request for id=not-the-pending-id'))).toBe(
      true,
    );

    stdout.write(
      `${JSON.stringify({
        protocolVersion: 1,
        id: realId,
        result: { graph: graphTagged('correct', '/tmp/ws-mismatch') },
      })}\n`,
    );
    await expect(pending).resolves.toMatchObject({ graph: { projectName: 'correct' } });
    await client.shutdown();
  });
});

/** Auto-answers initialize; queues other requests for the test to respond to. */
function installDeferredEngine(held: EngineReq[]) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    killed: false,
    kill: vi.fn(),
  });
  stdin.on('data', (buf: Buffer) => {
    for (const line of buf.toString().split('\n').filter((l) => l.trim())) {
      const req = JSON.parse(line) as EngineReq;
      if (req.method === 'initialize') {
        stdout.write(
          `${JSON.stringify({
            protocolVersion: 1,
            id: req.id,
            result: {
              engineVersion: 'test',
              protocolVersion: 1,
              capabilities: {
                networkGraph: true,
                temporalGraph: true,
                fixtureGraph: true,
              },
            },
          })}\n`,
        );
        continue;
      }
      if (req.method === 'shutdown') {
        stdout.write(
          `${JSON.stringify({ protocolVersion: 1, id: req.id, result: { ok: true } })}\n`,
        );
        continue;
      }
      held.push(req);
    }
  });
  spawnMock.mockReturnValue(child);
  return { child, stdout, stderr, stdin };
}
