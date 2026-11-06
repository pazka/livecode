// Maps a line / column of the JavaScript the preview runs back to the TypeScript the room wrote (source map
// v3 "mappings": base64 VLQ). The browser reports the script's errors and the loop guard its stops against the
// JavaScript; the editor shows them on the TypeScript line. Pure: tested in tests/typescript_test.ts.

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const VALUE = new Map([...B64].map((c, i) => [c, i]));

/** One mapping: generated column → source line and column (all 0-based). */
type Segment = [genCol: number, srcLine: number, srcCol: number];

/** The segments of each generated line (only segments that point into the source). */
export function decodeMappings(mappings: string): Segment[][] {
  const lines: Segment[][] = [];
  let srcLine = 0, srcCol = 0, srcIdx = 0, name = 0;
  for (const lineText of mappings.split(";")) {
    const segs: Segment[] = [];
    let genCol = 0;
    for (const seg of lineText.split(",")) {
      if (!seg) continue;
      const v = vlq(seg);
      if (!v.length) continue;
      genCol += v[0];
      if (v.length >= 4) {
        srcIdx += v[1];
        srcLine += v[2];
        srcCol += v[3];
        if (v.length >= 5) name += v[4];
        segs.push([genCol, srcLine, srcCol]);
      }
    }
    lines.push(segs);
  }
  return lines;
}

function vlq(s: string): number[] {
  const out: number[] = [];
  let value = 0, shift = 0;
  for (const c of s) {
    const d = VALUE.get(c);
    if (d === undefined) return [];
    value += (d & 31) << shift;
    if (d & 32) {
      shift += 5;
    } else {
      out.push(value & 1 ? -(value >>> 1) : value >>> 1);
      value = 0;
      shift = 0;
    }
  }
  return out;
}

export interface SourcePoint {
  /** 1-based. */
  line: number;
  /** 1-based; 0 = unknown. */
  col: number;
}

/**
 * A lookup from the generated script (1-based line, 1-based column or 0 = unknown) to the source. A line
 * without a mapping of its own (the `"use strict"` TypeScript adds, a blank line) takes the nearest mapped
 * line above it; nothing at all → null.
 */
export function sourceLookup(map: string): (line: number, col: number) => SourcePoint | null {
  let lines: Segment[][] = [];
  try {
    const m = JSON.parse(map) as { version?: number; mappings?: unknown };
    if (m.version === 3 && typeof m.mappings === "string") lines = decodeMappings(m.mappings);
  } catch { /* no map: nothing maps */ }
  return (line, col) => {
    for (let l = Math.min(line, lines.length) - 1; l >= 0; l--) {
      const segs = lines[l];
      if (!segs.length) continue;
      if (l !== line - 1 || col <= 0) {
        const s = l === line - 1 ? segs[0] : segs[segs.length - 1];
        return { line: s[1] + 1, col: l === line - 1 && col > 0 ? s[2] + 1 : 0 };
      }
      let best = segs[0];
      for (const s of segs) if (s[0] <= col - 1) best = s;
      return { line: best[1] + 1, col: best[2] + 1 + Math.max(0, col - 1 - best[0]) };
    }
    return null;
  };
}
