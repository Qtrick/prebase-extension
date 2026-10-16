import { describe, expect, it } from 'vitest';
import { isActiveRequest } from './requestSeq';

describe('isActiveRequest', () => {
  it('allows the current sequence when the panel is live', () => {
    expect(isActiveRequest(3, 3, false)).toBe(true);
  });

  it('rejects stale sequences superseded by a newer request', () => {
    expect(isActiveRequest(2, 3, false)).toBe(false);
    expect(isActiveRequest(1, 5, false)).toBe(false);
  });

  it('rejects sequences ahead of the current counter (equality gate)', () => {
    expect(isActiveRequest(4, 3, false)).toBe(false);
    expect(isActiveRequest(0, 1, false)).toBe(false);
  });

  it('rejects every sequence after dispose', () => {
    expect(isActiveRequest(7, 7, true)).toBe(false);
    expect(isActiveRequest(1, 2, true)).toBe(false);
  });

  it('models panel race: superseded in-flight request must not publish', () => {
    let graphRequestSeq = 0;
    const published: string[] = [];

    const startLoad = (label: string) => {
      const seq = ++graphRequestSeq;
      return {
        seq,
        publishIfActive: () => {
          if (!isActiveRequest(seq, graphRequestSeq, false)) return;
          published.push(label);
        },
      };
    };

    const first = startLoad('stale');
    const second = startLoad('fresh');
    // Late completion of the first request after a newer seq started.
    first.publishIfActive();
    second.publishIfActive();

    expect(published).toEqual(['fresh']);
    expect(isActiveRequest(first.seq, graphRequestSeq, false)).toBe(false);
    expect(isActiveRequest(second.seq, graphRequestSeq, false)).toBe(true);
  });

  it('models dispose race: in-flight success must not publish after dispose', () => {
    let graphRequestSeq = 0;
    let disposed = false;
    const published: string[] = [];

    const seq = ++graphRequestSeq;
    disposed = true;
    if (isActiveRequest(seq, graphRequestSeq, disposed)) {
      published.push('should-not-publish');
    }
    expect(published).toEqual([]);
  });
});
