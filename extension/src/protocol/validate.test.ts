import { describe, expect, it } from 'vitest';
import { isCanonicalGraph, parseEngineResponse } from '../../../shared/protocol/src/index';
import { validateEngineLine, validateWebviewMessage } from './validate';

describe('validateWebviewMessage', () => {
  it('accepts ready', () => {
    expect(validateWebviewMessage({ type: 'ready' })).toEqual({ type: 'ready' });
  });

  it('rejects unknown types', () => {
    expect(validateWebviewMessage({ type: 'explode' })).toBeNull();
  });

  it('rejects host-bound and engine-shaped message types from the webview', () => {
    for (const type of [
      'graph',
      'status',
      'error',
      'ack',
      'temporalTimeline',
      'temporalSnapshot',
      'temporalIndexResult',
      'temporalCompareResult',
      'initialize',
      'getNetworkGraph',
      'shutdown',
      '__proto__',
      'constructor',
      '',
    ]) {
      expect(validateWebviewMessage({ type }), type).toBeNull();
    }
  });

  it('rejects prototype-pollution style payloads', () => {
    expect(validateWebviewMessage(JSON.parse('{"type":"ready","__proto__":{"x":1}}'))).toEqual({
      type: 'ready',
    });
    expect(
      validateWebviewMessage({
        type: 'selectNode',
        nodeId: 'file:src/a.ts',
        __proto__: { admin: true },
      }),
    ).toEqual({ type: 'selectNode', nodeId: 'file:src/a.ts' });
  });

  it('validates setView', () => {
    expect(validateWebviewMessage({ type: 'setView', view: 'temporal' })).toEqual({
      type: 'setView',
      view: 'temporal',
    });
    expect(validateWebviewMessage({ type: 'setView', view: 'other' })).toBeNull();
  });

  it('validates selectNode', () => {
    expect(validateWebviewMessage({ type: 'selectNode', nodeId: 'file:src/a.ts' })).toEqual({
      type: 'selectNode',
      nodeId: 'file:src/a.ts',
    });
    expect(validateWebviewMessage({ type: 'selectNode', nodeId: 'mod:app' })).toEqual({
      type: 'selectNode',
      nodeId: 'mod:app',
    });
    expect(validateWebviewMessage({ type: 'selectNode', nodeId: 'a' })).toBeNull();
    expect(validateWebviewMessage({ type: 'selectNode', nodeId: 'file:../escape' })).toBeNull();
    expect(validateWebviewMessage({ type: 'selectNode', nodeId: 1 })).toBeNull();
    expect(validateWebviewMessage({ type: 'selectNode', nodeId: null })).toEqual({
      type: 'selectNode',
      nodeId: null,
    });
  });

  it('accepts requestGraph and retry', () => {
    expect(validateWebviewMessage({ type: 'requestGraph' })).toEqual({ type: 'requestGraph' });
    expect(validateWebviewMessage({ type: 'retry' })).toEqual({ type: 'retry' });
  });

  it('validates temporalIndex', () => {
    expect(validateWebviewMessage({ type: 'temporalIndex' })).toEqual({ type: 'temporalIndex' });
    expect(validateWebviewMessage({ type: 'temporalIndex', limit: 40 })).toEqual({
      type: 'temporalIndex',
      limit: 40,
    });
    expect(validateWebviewMessage({ type: 'temporalIndex', limit: '40' })).toBeNull();
    expect(validateWebviewMessage({ type: 'temporalIndex', limit: Number.NaN })).toBeNull();
    expect(validateWebviewMessage({ type: 'temporalIndex', limit: Number.POSITIVE_INFINITY })).toBeNull();
    expect(validateWebviewMessage({ type: 'temporalIndex', limit: 0 })).toBeNull();
    expect(validateWebviewMessage({ type: 'temporalIndex', limit: -1 })).toBeNull();
    expect(validateWebviewMessage({ type: 'temporalIndex', limit: 1.5 })).toBeNull();
    expect(validateWebviewMessage({ type: 'temporalIndex', limit: 10_001 })).toBeNull();
  });

  it('validates temporalSelect', () => {
    expect(
      validateWebviewMessage({
        type: 'temporalSelect',
        commitOid: 'abcd1234abcd1234abcd1234abcd1234abcd1234',
      }),
    ).toEqual({
      type: 'temporalSelect',
      commitOid: 'abcd1234abcd1234abcd1234abcd1234abcd1234',
    });
    const sha256 = 'a'.repeat(64);
    expect(
      validateWebviewMessage({ type: 'temporalSelect', commitOid: sha256 }),
    ).toEqual({ type: 'temporalSelect', commitOid: sha256 });
    expect(validateWebviewMessage({ type: 'temporalSelect', commitOid: 'a'.repeat(65) })).toBeNull();
    expect(validateWebviewMessage({ type: 'temporalSelect', commitOid: 'not-a-sha' })).toBeNull();
    expect(validateWebviewMessage({ type: 'temporalSelect', commitOid: 'abc' })).toBeNull();
  });

  it('validates temporalCompare', () => {
    expect(
      validateWebviewMessage({
        type: 'temporalCompare',
        baseCommitOid: '1111111111111111111111111111111111111111',
        targetCommitOid: '2222222222222222222222222222222222222222',
      }),
    ).toEqual({
      type: 'temporalCompare',
      baseCommitOid: '1111111111111111111111111111111111111111',
      targetCommitOid: '2222222222222222222222222222222222222222',
    });
    expect(
      validateWebviewMessage({
        type: 'temporalCompare',
        baseCommitOid: '1111111111111111111111111111111111111111',
        targetCommitOid: 'bad',
      }),
    ).toBeNull();
  });

  it('rejects non-object and missing type payloads', () => {
    expect(validateWebviewMessage(null)).toBeNull();
    expect(validateWebviewMessage('ready')).toBeNull();
    expect(validateWebviewMessage([])).toBeNull();
    expect(validateWebviewMessage({})).toBeNull();
    expect(validateWebviewMessage({ type: 42 })).toBeNull();
  });

  it('rejects path-traversal and oversized selectNode ids', () => {
    expect(validateWebviewMessage({ type: 'selectNode', nodeId: 'file:..\\escape' })).toBeNull();
    expect(validateWebviewMessage({ type: 'selectNode', nodeId: 'file:a/../../etc/passwd' })).toBeNull();
    expect(validateWebviewMessage({ type: 'selectNode', nodeId: 'file:' + 'x'.repeat(520) })).toBeNull();
    expect(validateWebviewMessage({ type: 'selectNode', nodeId: '   ' })).toBeNull();
  });
});

describe('validateEngineLine', () => {
  it('parses success responses', () => {
    const line = JSON.stringify({
      protocolVersion: 1,
      id: '1',
      result: { ok: true },
    });
    const resp = validateEngineLine(line);
    expect(resp?.id).toBe('1');
    expect(resp?.result).toEqual({ ok: true });
  });

  it('rejects malformed JSON', () => {
    expect(validateEngineLine('{nope')).toBeNull();
  });

  it('rejects missing id', () => {
    expect(validateEngineLine(JSON.stringify({ protocolVersion: 1 }))).toBeNull();
  });

  it('rejects unsupported protocolVersion on responses', () => {
    expect(
      validateEngineLine(
        JSON.stringify({ protocolVersion: 99, id: '1', result: { ok: true } }),
      ),
    ).toBeNull();
  });

  it('parses structured engine errors including unsupported_version', () => {
    const line = JSON.stringify({
      protocolVersion: 1,
      id: '9',
      error: {
        category: 'unsupported_version',
        message: 'Unsupported protocol version 2',
      },
    });
    const resp = validateEngineLine(line);
    expect(resp?.error?.category).toBe('unsupported_version');
    expect(resp?.result).toBeUndefined();
  });

  it('rejects responses with invalid error shape', () => {
    expect(
      validateEngineLine(
        JSON.stringify({ protocolVersion: 1, id: '1', error: 'not-an-object' }),
      ),
    ).toBeNull();
  });
});

describe('parseEngineResponse', () => {
  it('rejects non-records and missing protocolVersion', () => {
    expect(parseEngineResponse(null)).toBeNull();
    expect(parseEngineResponse({ id: '1' })).toBeNull();
    expect(parseEngineResponse({ protocolVersion: 99, id: '1' })).toBeNull();
  });
});

describe('isCanonicalGraph', () => {
  it('accepts graphs with optional coverage stats', () => {
    const graph = {
      nodes: [],
      edges: [],
      projectPath: '/ws',
      projectName: 'ws',
      entryNodeId: null,
      revision: 'r1',
      provenance: 'repository' as const,
      versions: {
        graphSchemaVersion: 1,
        analyzerVersion: 2,
        identityVersion: 1,
      },
      coverage: {
        discoveredFiles: 3,
        analyzedFiles: 2,
        unsupportedFiles: 0,
        parseFailures: 0,
        resolvedImports: 1,
        unresolvedImports: 0,
        externalImports: 0,
        ambiguousImports: 0,
        excludedPaths: 0,
        durationMs: 12,
      },
    };
    expect(isCanonicalGraph(graph)).toBe(true);
  });
});
