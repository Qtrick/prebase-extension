import {
  type EngineResponse,
  type WebviewToHost,
  isRecord,
  parseEngineResponse,
} from '../../../shared/protocol/src/index';

export function validateWebviewMessage(raw: unknown): WebviewToHost | null {
  if (!isRecord(raw) || typeof raw.type !== 'string') {
    return null;
  }
  switch (raw.type) {
    case 'ready':
    case 'requestGraph':
    case 'retry':
      return { type: raw.type };
    case 'selectNode': {
      if (raw.nodeId !== null && typeof raw.nodeId !== 'string') return null;
      if (typeof raw.nodeId === 'string') {
        const nodeId = raw.nodeId.trim();
        if (nodeId.length === 0 || nodeId.length > 512) return null;
        // Stable graph IDs are prefix:path forms (file:, mod:, …). Reject traversal.
        if (nodeId.includes('\\') || nodeId.includes('..')) return null;
        if (!/^[a-z]+:/i.test(nodeId)) return null;
        return { type: 'selectNode', nodeId };
      }
      return { type: 'selectNode', nodeId: null };
    }
    case 'setView': {
      if (raw.view !== 'network' && raw.view !== 'temporal') return null;
      return { type: 'setView', view: raw.view };
    }
    case 'temporalIndex': {
      if (raw.limit !== undefined) {
        if (typeof raw.limit !== 'number' || !Number.isFinite(raw.limit)) return null;
        if (!Number.isInteger(raw.limit) || raw.limit < 1 || raw.limit > 10_000) {
          return null;
        }
      }
      return {
        type: 'temporalIndex',
        limit: typeof raw.limit === 'number' ? raw.limit : undefined,
      };
    }
    case 'temporalSelect': {
      if (typeof raw.commitOid !== 'string' || !/^[0-9a-f]{7,64}$/i.test(raw.commitOid)) {
        return null;
      }
      return { type: 'temporalSelect', commitOid: raw.commitOid };
    }
    case 'temporalCompare': {
      if (
        typeof raw.baseCommitOid !== 'string' ||
        typeof raw.targetCommitOid !== 'string' ||
        !/^[0-9a-f]{7,64}$/i.test(raw.baseCommitOid) ||
        !/^[0-9a-f]{7,64}$/i.test(raw.targetCommitOid)
      ) {
        return null;
      }
      return {
        type: 'temporalCompare',
        baseCommitOid: raw.baseCommitOid,
        targetCommitOid: raw.targetCommitOid,
      };
    }
    default:
      return null;
  }
}

export function validateEngineLine(line: string): EngineResponse | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return parseEngineResponse(parsed);
}

export { parseEngineResponse };
