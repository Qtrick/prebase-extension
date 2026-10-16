import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EngineClient, EngineClientError } from './EngineClient';

const repoRoot = join(__dirname, '../../..');
const binary = join(
  repoRoot,
  'target',
  process.env.PREBASE_ENGINE_PROFILE === 'release' ? 'release' : 'debug',
  process.platform === 'win32' ? 'prebase-engine.exe' : 'prebase-engine',
);

const hasBinary = existsSync(binary) || existsSync(join(repoRoot, 'extension', 'bin', 'prebase-engine'));

describe.skipIf(!hasBinary)('EngineClient integration', () => {
  let client: EngineClient;

  beforeAll(async () => {
    client = new EngineClient(join(repoRoot, 'extension'), () => undefined, 10_000);
    await client.start();
  }, 30_000);

  afterAll(async () => {
    await client.shutdown();
  });

  it('returns an explicitly requested fixture graph', async () => {
    const result = await client.getNetworkGraph('/tmp/prebase-test-ws', {
      preferFixture: true,
    });
    expect(result.graph.provenance).toBe('fixture');
    expect(result.graph.nodes.length).toBeGreaterThan(0);
  });

  it('analyzes the PreBase repository for real import edges', async () => {
    const result = await client.getNetworkGraph(repoRoot, {
      preferFixture: false,
      timeoutMs: 90_000,
    });
    expect(result.graph.provenance).toBe('repository');
    expect(result.graph.nodes.length).toBeGreaterThan(5);
    expect(result.graph.edges.some((e) => e.kind === 'import')).toBe(true);
    expect(result.graph.coverage?.analyzedFiles).toBeGreaterThan(0);
  }, 90_000);

  it('rejects after dispose', async () => {
    const c = new EngineClient(join(repoRoot, 'extension'), () => undefined);
    await c.start();
    c.dispose();
    await expect(c.getNetworkGraph('/tmp/x')).rejects.toBeInstanceOf(EngineClientError);
  });
});

describe('EngineClient path resolution', () => {
  it('throws when binary missing', () => {
    const client = new EngineClient('/nonexistent/extension/path', () => undefined);
    expect(() => client.resolveBinaryPath()).toThrow(/not found/);
  });
});
