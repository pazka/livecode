// The code area shows one, two or all three files side by side or stacked, in the order the person
// chooses (drag a pane's title bar or a file button, or the move buttons), each pane resizable. Pure list
// operations here (tests/panes_test.ts); main.ts draws them. The order is per person (settings.ts).

import { type FileId, FILES } from "../shared/protocol.ts";
import { PANE_MAX, PANE_MIN } from "./settings.ts";

export type Panes = readonly FileId[];

/** Show `f`: already shown → unchanged; otherwise it takes the slot of the file being edited. */
export function goToPane(panes: Panes, current: FileId, f: FileId): FileId[] {
  if (panes.includes(f)) return [...panes];
  const i = panes.indexOf(current);
  const out = [...panes];
  out[i < 0 ? out.length - 1 : i] = f;
  return out;
}

/** The first hidden file after `from` in the usual order (HTML, CSS, JS), wrapping around. */
export function nextHidden(panes: Panes, from: FileId): FileId | null {
  const i = FILES.indexOf(from);
  for (let k = 1; k <= FILES.length; k++) {
    const f = FILES[(i + k) % FILES.length];
    if (!panes.includes(f)) return f;
  }
  return null;
}

/** Open another file right after `current` (VS Code "split editor"); unchanged when all are shown. */
export function openBeside(
  panes: Panes,
  current: FileId,
  f: FileId | null = nextHidden(panes, current),
): FileId[] {
  if (!f || panes.includes(f)) return [...panes];
  const i = panes.indexOf(current);
  const out = [...panes];
  out.splice(i < 0 ? out.length : i + 1, 0, f);
  return out;
}

/** Show `n` files (1–3), keeping the current one and the order. */
export function setPaneCount(panes: Panes, current: FileId, n: number): FileId[] {
  const keep = panes.includes(current) ? current : panes[0];
  if (n <= 1) return [keep];
  if (n >= FILES.length) return [...panes, ...FILES.filter((f) => !panes.includes(f))];
  if (panes.length > n) {
    // drop files other than the current one, from the end
    const out = [...panes];
    for (let i = out.length - 1; i >= 0 && out.length > n; i--) if (out[i] !== keep) out.splice(i, 1);
    return out;
  }
  let out = [...panes];
  while (out.length < n) out = openBeside(out, out[out.length - 1]);
  return out;
}

/** Hide a file's pane (never the last one). */
export function closePane(panes: Panes, f: FileId): FileId[] {
  return panes.length > 1 ? panes.filter((p) => p !== f) : [...panes];
}

/** Move a pane one place back (-1) or forward (+1). */
export function movePane(panes: Panes, f: FileId, delta: -1 | 1): FileId[] {
  const i = panes.indexOf(f);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= panes.length) return [...panes];
  const out = [...panes];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** Drop `f` (shown or not) before or after the pane of `target`. */
export function dropPane(panes: Panes, f: FileId, target: FileId, after: boolean): FileId[] {
  if (f === target) return [...panes];
  const out = panes.filter((p) => p !== f);
  const t = out.indexOf(target);
  if (t < 0) return [...panes];
  out.splice(after ? t + 1 : t, 0, f);
  return out;
}

/**
 * New sizes of two neighbouring panes when the separator between them moves: `frac` is the first one's
 * share of the pair (0–1). Their total is kept; each stays within PANE_MIN–PANE_MAX.
 */
export function resizePair(
  sizes: Readonly<Record<FileId, number>>,
  a: FileId,
  b: FileId,
  frac: number,
): Record<FileId, number> {
  const total = sizes[a] + sizes[b];
  const lo = Math.max(PANE_MIN, total - PANE_MAX);
  const hi = Math.min(PANE_MAX, total - PANE_MIN);
  const na = Math.max(lo, Math.min(hi, total * Math.max(0, Math.min(1, frac))));
  const round = (x: number) => Math.round(x * 1000) / 1000;
  return { ...sizes, [a]: round(na), [b]: round(total - na) };
}

/** Side by side when each pane would get at least `minWidth` pixels, else stacked. */
export function autoDirection(width: number, count: number, minWidth = 380): "row" | "column" {
  return count <= 1 || width / count >= minWidth ? "row" : "column";
}
