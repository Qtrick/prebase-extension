/**
 * Gate async panel updates so a superseded request cannot publish stale UI state.
 * Used for both network graph and temporal request sequencing.
 */
export function isActiveRequest(
  seq: number,
  currentSeq: number,
  disposed: boolean,
): boolean {
  return !disposed && seq === currentSeq;
}
