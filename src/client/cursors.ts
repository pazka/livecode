// Remote cursors: a name chip above every caret, except where carets crowd together (owner: "at 8 characters
// of distance, if there is more than one cursor, don't show the name chip"). Pure: tests/unit_test.ts.

/** Carets this close (same line, in characters) hide their name chips; hovering a caret still shows it. */
export const CROWD_DISTANCE = 8;

export interface CaretPoint {
  line: number;
  col: number;
}

/**
 * For each remote caret: true when another caret — someone else's, or mine — is on the same line within
 * `d` characters. `null` entries (not on screen) are never crowded and crowd nobody.
 */
export function crowdedCarets(
  remote: readonly (CaretPoint | null)[],
  mine: CaretPoint | null,
  d = CROWD_DISTANCE,
): boolean[] {
  const all = mine ? [...remote, mine] : remote;
  return remote.map((p, i) =>
    p !== null &&
    all.some((q, j) => j !== i && q !== null && q.line === p.line && Math.abs(q.col - p.col) <= d)
  );
}
