// Formatting (owner 2026-11-13: "opt out autoformat, on by default, on all files"; 2026-11-14: "format when
// hitting ctrl+s … and/or when I'm typing … bracket, inner spacing etc. to be formatted too").
//
// What "formatted" means, per file:
// - the script (JavaScript or TypeScript): TypeScript's own formatter (worker) — indentation, a space around
//   operators, after commas / colons / keywords, inside braces; lines are never joined or wrapped, quotes and
//   semicolons stay as written, template strings are untouched;
// - the stylesheet: indentation, one space before `{`, `name: value`, a space after each `;` and inside a
//   one-line `{ … }`;
// - the HTML: indentation (with its <style> / <script>), never inside <pre> / <textarea>;
// - everywhere: trailing spaces removed.
//
// When:
// - as the person types (per person, on by default — Settings → Editor, or the palette): a moment after they
//   stop — at once after a paste or a drop — the lines THEY changed are formatted. The line the caret is on
//   only gets its indentation (never its spacing or its trailing space: the person is still writing it) and
//   is finished once the caret has left it. One undo step of its own: undo puts the code back as typed;
// - the whole file (formatFile): on Run / Ctrl+S when the option is on, and with the "Format file" command.
//
// Shared code: a line holding someone else's caret, or that someone else edits meanwhile, is never touched
// (two people re-indenting one line at once would both insert the indentation — doubled).

import {
  type ChangeSpec,
  type EditorState,
  type Extension,
  Facet,
  StateEffect,
  StateField,
  type Transaction,
} from "@codemirror/state";
import { type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { getIndentation, getIndentUnit, IndentContext, indentString, syntaxTree } from "@codemirror/language";
import { ySyncAnnotation } from "y-codemirror.next";
import type { TextEdit } from "./ts/service.ts";

/** Quiet time after the person's last edit before their lines are formatted (ms). */
export const AUTOFORMAT_DELAY = 1000;

/** The user events of the formatting transactions (as the person types / a whole file). */
export const AUTOFORMAT_EVENT = "format.auto";
export const FORMAT_FILE_EVENT = "format.file";

export interface FormatConfig {
  /** A stylesheet: `a{color:red}` gets its spaces. */
  css?: boolean;
  /** The file's real formatter (the script: TypeScript's, in the worker): the changes for `text`. */
  deep?: (text: string, indent: number) => Promise<TextEdit[]>;
  /** Where the other people's carets are in this file (document positions). */
  others?: () => number[];
}

const formatConfig = Facet.define<FormatConfig, FormatConfig | null>({
  combine: (v) => v[0] ?? null,
});

/** A stretch of the document the person changed and that is not formatted yet. */
type Span = readonly [from: number, to: number];

/** After a format: what is still to do (the caret's lines, formatted in full once the caret has left). */
const formatted = StateEffect.define<Span[]>();

const isRemote = (tr: Transaction) => tr.annotation(ySyncAnnotation) !== undefined;
/** The person's own typing, deleting, pasting, dropping, moving lines (not undo / redo / format). */
export const isOwnEdit = (tr: Transaction) =>
  tr.docChanged && !isRemote(tr) &&
  (tr.isUserEvent("input") || tr.isUserEvent("delete") || tr.isUserEvent("move"));

/** What the person changed since the last format, kept in step with every change (theirs and others'). */
export const pendingLines = StateField.define<Span[]>({
  create: () => [],
  update(spans, tr) {
    for (const e of tr.effects) if (e.is(formatted)) spans = e.value; // positions before this change
    // undo / redo put text back as it was: never formatted again behind the person's back
    if (tr.isUserEvent("undo") || tr.isUserEvent("redo")) return [];
    if (!tr.docChanged) return spans;
    let out: Span[] = spans.map(([a, b]) => [tr.changes.mapPos(a, -1), tr.changes.mapPos(b, 1)]);
    const doc = tr.newDoc;
    const lines = ([a, b]: Span): Span => [doc.lineAt(a).from, doc.lineAt(b).to];
    if (isRemote(tr)) {
      // someone else is on these lines: leave them to them
      const theirs: Span[] = [];
      tr.changes.iterChangedRanges((_fa, _ta, fb, tb) => theirs.push(lines([fb, tb])));
      out = out.filter((s) => {
        const [a, b] = lines(s);
        return !theirs.some(([c, d]) => a <= d && c <= b);
      });
    } else if (isOwnEdit(tr)) {
      tr.changes.iterChangedRanges((_fa, _ta, fb, tb) => out.push([fb, tb]));
    }
    return merge(out);
  },
});

function merge(spans: Span[]): Span[] {
  if (spans.length < 2) return spans;
  const sorted = [...spans].sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [[sorted[0][0], sorted[0][1]]];
  for (const [a, b] of sorted.slice(1)) {
    const last = out[out.length - 1];
    if (a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** The numbers of the lines the spans touch. */
function linesOf(state: EditorState, spans: readonly Span[]): Set<number> {
  const doc = state.doc;
  const clamp = (p: number) => Math.max(0, Math.min(doc.length, p));
  const out = new Set<number>();
  for (const [a, b] of spans) {
    for (let n = doc.lineAt(clamp(a)).number; n <= doc.lineAt(clamp(b)).number; n++) out.add(n);
  }
  return out;
}

/** The lines the person's carets (and selection ends) are on. */
function caretLines(state: EditorState): Set<number> {
  const out = new Set<number>();
  for (const r of state.selection.ranges) {
    out.add(state.doc.lineAt(r.head).number);
    out.add(state.doc.lineAt(r.anchor).number);
  }
  return out;
}

/** Whitespace there is the page's content: a template string, the inside of <pre> or <textarea>. */
const VERBATIM_TAGS = new Set(["pre", "textarea"]);
type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]>;
function verbatim(state: EditorState, pos: number, side: -1 | 1): boolean {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) {
    if (n.name === "TemplateString") return true;
    if (n.name === "Element") {
      const open = n.firstChild;
      const tag = open?.name === "OpenTag" ? open.getChild("TagName") : null;
      if (!open || !tag || !VERBATIM_TAGS.has(state.sliceDoc(tag.from, tag.to).toLowerCase())) continue;
      const close = n.lastChild;
      if (pos >= open.to && (close?.name !== "CloseTag" || pos <= close.from)) return true;
    }
  }
  return false;
}

/**
 * Indentation and trailing spaces of `lines`: each re-indented as the language says (blank ones emptied),
 * trailing spaces removed. `light` lines (under a caret) keep their trailing spaces and, when blank, their
 * indentation.
 */
function indentTrim(state: EditorState, lines: Iterable<number>, light: ReadonlySet<number>): ChangeSpec[] {
  const doc = state.doc;
  // as indentRange does: a line re-indented here counts for the lines after it
  const updated: Record<number, number> = {};
  const cx = new IndentContext(state, { overrideIndentation: (start) => updated[start] ?? -1 });
  const changes: ChangeSpec[] = [];
  for (const n of [...lines].sort((x, y) => x - y)) {
    const line = doc.line(n);
    const blank = !/\S/.test(line.text);
    const atCaret = light.has(n);
    if (blank && (atCaret || !line.length)) continue;
    const want = verbatim(state, line.from, 1) ? null : getIndentation(cx, line.from);
    if (want !== null) {
      const indent = blank ? 0 : want;
      const cur = /^\s*/.exec(line.text)![0];
      const norm = indentString(state, indent);
      if (cur !== norm) {
        updated[line.from] = indent;
        changes.push({ from: line.from, to: line.from + cur.length, insert: norm });
      }
    }
    if (!blank && !atCaret) {
      const trailing = /\S(\s+)$/.exec(line.text);
      if (trailing && !verbatim(state, line.to, -1)) {
        changes.push({ from: line.to - trailing[1].length, to: line.to });
      }
    }
  }
  return changes;
}

/**
 * The changes that format the lines in `spans` without a real formatter: indentation and trailing spaces.
 * Lines under a caret keep their trailing spaces and, when blank, their indentation.
 */
export function formatChanges(state: EditorState, spans: readonly Span[]): ChangeSpec[] {
  return indentTrim(state, linesOf(state, spans), caretLines(state));
}

/**
 * The spaces of a stylesheet, between two things on the same line only (never a line's indentation or its
 * end): one before `{`, none before and one after the `:` of a declaration, one after `;`, one inside each
 * end of a one-line `{ … }`.
 */
export function cssSpacing(state: EditorState): { from: number; to: number; insert: string }[] {
  const out: { from: number; to: number; insert: string }[] = [];
  const gap = (from: number, to: number, want: string) => {
    if (to < from) return;
    const cur = state.sliceDoc(from, to);
    if (cur === want || /\S|\n/.test(cur)) return;
    out.push({ from, to, insert: want });
  };
  syntaxTree(state).iterate({
    enter: (n) => {
      if (n.type.isError) return false;
      if (n.name === "Declaration") {
        const name = n.node.firstChild;
        const colon = name?.nextSibling;
        const value = colon?.nextSibling;
        if (name && colon?.name === ":") {
          gap(name.to, colon.from, "");
          if (value && value.name !== ";") gap(colon.to, value.from, " ");
        }
      } else if (n.name === "Block") {
        const node = n.node;
        const before = node.prevSibling;
        if (before) gap(before.to, node.from, " ");
        const open = node.firstChild;
        const close = node.lastChild;
        if (open?.name !== "{") return;
        const first = open.nextSibling;
        if (first && first.name !== "}") gap(open.to, first.from, " ");
        if (close?.name === "}" && close.prevSibling && close.prevSibling.name !== "{") {
          gap(close.prevSibling.to, close.from, " ");
        }
        for (let c = open.nextSibling; c; c = c.nextSibling) {
          if (c.name === ";" && c.nextSibling && c.nextSibling.name !== "}") {
            gap(c.to, c.nextSibling.from, " ");
          }
        }
      }
    },
  });
  return out;
}

/**
 * The changes that format `lines`. `light` lines (the person is still writing them) only get their
 * indentation. With `edits` (the real formatter's, for the whole text) the other lines take those; without,
 * indentation + trailing spaces (+ the stylesheet's spaces).
 */
export function planFormat(
  state: EditorState,
  lines: ReadonlySet<number>,
  light: ReadonlySet<number>,
  edits: readonly TextEdit[] | null,
): ChangeSpec[] {
  const doc = state.doc;
  const full = (pos: number) => {
    const n = doc.lineAt(Math.max(0, Math.min(doc.length, pos))).number;
    return lines.has(n) && !light.has(n);
  };
  if (edits) {
    const lightLines = [...lines].filter((n) => light.has(n));
    return [
      ...edits.filter((e) => e.from <= e.to && e.to <= doc.length && full(e.from) && full(e.to)),
      ...indentTrim(state, lightLines, light),
    ];
  }
  const changes = indentTrim(state, lines, light);
  if (state.facet(formatConfig)?.css) {
    changes.push(...cssSpacing(state).filter((c) => full(c.from) && full(c.to)));
  }
  return changes;
}

/** The lines holding someone else's caret: theirs, never formatted from here. */
function othersLines(state: EditorState): Set<number> {
  const doc = state.doc;
  const out = new Set<number>();
  for (const pos of state.facet(formatConfig)?.others?.() ?? []) {
    if (Number.isFinite(pos)) out.add(doc.lineAt(Math.max(0, Math.min(doc.length, pos))).number);
  }
  return out;
}

/** The real formatter's changes for the document as it is now; null when there is none (or it failed). */
async function deepEdits(state: EditorState): Promise<TextEdit[] | null> {
  const deep = state.facet(formatConfig)?.deep;
  if (!deep || !state.doc.length) return null;
  try {
    return await deep(state.doc.toString(), getIndentUnit(state));
  } catch {
    return null;
  }
}

/**
 * Formats the person's pending lines now. Resolves "stale" when the text changed while the formatter was
 * working (nothing done: to be asked again), else whether anything changed.
 */
export async function formatPending(view: EditorView): Promise<boolean | "stale"> {
  if (!view.state.field(pendingLines, false)?.length) return false;
  const doc = view.state.doc;
  const edits = await deepEdits(view.state);
  const state = view.state;
  if (state.doc !== doc) return "stale";
  const spans = state.field(pendingLines, false) ?? [];
  if (!spans.length) return false;
  const lines = linesOf(state, spans);
  for (const n of othersLines(state)) lines.delete(n);
  const light = caretLines(state);
  const changes = planFormat(state, lines, light, edits);
  // the caret's lines stay to do: finished once the caret has left them
  const keep: Span[] = [...lines].filter((n) => light.has(n)).map((n) => [doc.line(n).from, doc.line(n).to]);
  view.dispatch({ changes, effects: formatted.of(keep), userEvent: AUTOFORMAT_EVENT, scrollIntoView: false });
  return changes.length > 0;
}

/**
 * Formats the whole file now (Run / Ctrl+S, the "Format file" command): every line but the ones holding
 * someone else's caret. One undo step. Resolves with whether anything changed.
 */
export async function formatFile(view: EditorView): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const doc = view.state.doc;
    const edits = await deepEdits(view.state);
    const state = view.state;
    if (state.doc !== doc) continue; // someone typed meanwhile: ask again
    if (state.readOnly) return false;
    const lines = new Set<number>();
    for (let n = 1; n <= doc.lines; n++) lines.add(n);
    for (const n of othersLines(state)) lines.delete(n);
    const changes = planFormat(state, lines, new Set(), edits);
    const clear = state.field(pendingLines, false) ? [formatted.of([])] : [];
    if (changes.length || clear.length) {
      view.dispatch({ changes, effects: clear, userEvent: FORMAT_FILE_EVENT, scrollIntoView: false });
    }
    return changes.length > 0;
  }
  return false;
}

/** True where formatFile knows the file (an editor of the app; not a bare test state). */
export const canFormatFile = (state: EditorState) => state.facet(formatConfig) !== null;

const scheduler = ViewPlugin.fromClass(
  class {
    private timer: number | undefined;
    private stale = 0;
    constructor(readonly view: EditorView) {}
    update(u: ViewUpdate) {
      if (u.transactions.some(isOwnEdit)) {
        const dropped = u.transactions.some((tr) =>
          tr.isUserEvent("input.paste") || tr.isUserEvent("input.drop")
        );
        this.stale = 0;
        this.schedule(dropped ? 0 : AUTOFORMAT_DELAY);
      } else if (u.selectionSet && u.state.field(pendingLines).length) {
        // the caret left a line that was still to finish
        this.schedule(AUTOFORMAT_DELAY);
      }
    }
    schedule(ms: number) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        // never in the middle of an input-method composition (accents, CJK …)
        if (this.view.composing) return this.schedule(AUTOFORMAT_DELAY);
        formatPending(this.view).then((r) => {
          // the text changed under the formatter (someone else typing): a few more tries, then let it be
          if (r === "stale" && ++this.stale <= 5) this.schedule(300);
        }, () => {});
      }, ms);
    }
    destroy() {
      clearTimeout(this.timer);
    }
  },
);

/**
 * The editor extension: what the file's formatting is (`config`, for formatFile too) and — `on` — the
 * person's own lines formatted as they go.
 */
export function autoFormat(on: boolean, config: FormatConfig = {}): Extension {
  return [formatConfig.of(config), on ? [pendingLines, scheduler] : []];
}
