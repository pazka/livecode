// Autoformat (owner 2026-11-13: "opt out autoformat, on by default, on all files"): a moment after a person
// stops typing — at once after a paste or a drop — the lines THEY changed are re-indented from the language's
// syntax tree and lose their trailing spaces, in HTML, CSS and the script alike (JS or TS). Per person, on by
// default (Settings → Editor, or the palette). One undo step of its own: undo puts the code back as typed.
//
// Shared code, so it only ever touches the person's own fresh lines:
// - never a line someone else is editing: a line another person's edit lands on is dropped (two people
//   re-indenting the same line at once would both insert the indentation — doubled);
// - never the line under the person's caret if it is blank (the indentation they are about to type on) nor
//   its trailing spaces (the space before the next word);
// - never what is verbatim: inside a template string, or the content of an HTML <pre> / <textarea>.

import {
  type ChangeSpec,
  type EditorState,
  type Extension,
  StateEffect,
  StateField,
  type Transaction,
} from "@codemirror/state";
import { type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { getIndentation, IndentContext, indentString, syntaxTree } from "@codemirror/language";
import { ySyncAnnotation } from "y-codemirror.next";

/** Quiet time after the person's last edit before their lines are formatted (ms). */
export const AUTOFORMAT_DELAY = 1000;

/** The user event of an autoformat transaction. */
export const AUTOFORMAT_EVENT = "format.auto";

/** A stretch of the document the person changed and that is not formatted yet. */
type Span = readonly [from: number, to: number];

const formatted = StateEffect.define<null>();

const isRemote = (tr: Transaction) => tr.annotation(ySyncAnnotation) !== undefined;
/** The person's own typing, deleting, pasting, dropping, moving lines (not undo / redo / format). */
export const isOwnEdit = (tr: Transaction) =>
  tr.docChanged && !isRemote(tr) &&
  (tr.isUserEvent("input") || tr.isUserEvent("delete") || tr.isUserEvent("move"));

/** What the person changed since the last format, kept in step with every change (theirs and others'). */
export const pendingLines = StateField.define<Span[]>({
  create: () => [],
  update(spans, tr) {
    if (tr.effects.some((e) => e.is(formatted))) spans = [];
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
 * The changes that format the lines in `spans`: each re-indented as the language says (blank ones emptied),
 * trailing spaces removed. Lines under a caret keep their trailing spaces and, when blank, their indentation.
 */
export function formatChanges(state: EditorState, spans: readonly Span[]): ChangeSpec[] {
  const doc = state.doc;
  const clamp = (p: number) => Math.max(0, Math.min(doc.length, p));
  const lines = new Set<number>();
  for (const [a, b] of spans) {
    for (let n = doc.lineAt(clamp(a)).number; n <= doc.lineAt(clamp(b)).number; n++) lines.add(n);
  }
  const carets = new Set<number>();
  for (const r of state.selection.ranges) {
    carets.add(doc.lineAt(r.head).number);
    carets.add(doc.lineAt(r.anchor).number);
  }
  // as indentRange does: a line re-indented here counts for the lines after it
  const updated: Record<number, number> = {};
  const cx = new IndentContext(state, { overrideIndentation: (start) => updated[start] ?? -1 });
  const changes: ChangeSpec[] = [];
  for (const n of [...lines].sort((x, y) => x - y)) {
    const line = doc.line(n);
    const blank = !/\S/.test(line.text);
    const atCaret = carets.has(n);
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

/** Formats the person's pending lines now (and forgets them). */
export function formatPending(view: EditorView): boolean {
  const spans = view.state.field(pendingLines, false);
  if (!spans?.length) return false;
  const changes = formatChanges(view.state, spans);
  view.dispatch({
    changes,
    effects: formatted.of(null),
    userEvent: AUTOFORMAT_EVENT,
    scrollIntoView: false,
  });
  return changes.length > 0;
}

const scheduler = ViewPlugin.fromClass(
  class {
    private timer: number | undefined;
    constructor(readonly view: EditorView) {}
    update(u: ViewUpdate) {
      if (!u.transactions.some(isOwnEdit)) return;
      const dropped = u.transactions.some((tr) =>
        tr.isUserEvent("input.paste") || tr.isUserEvent("input.drop")
      );
      this.schedule(dropped ? 0 : AUTOFORMAT_DELAY);
    }
    schedule(ms: number) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        // never in the middle of an input-method composition (accents, CJK …)
        if (this.view.composing) return this.schedule(AUTOFORMAT_DELAY);
        formatPending(this.view);
      }, ms);
    }
    destroy() {
      clearTimeout(this.timer);
    }
  },
);

/** The editor extension: on, the person's own lines are formatted as they go; off, nothing. */
export function autoFormat(on: boolean): Extension {
  return on ? [pendingLines, scheduler] : [];
}
