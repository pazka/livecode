// Errors shown in the editors (owner, 2026-11-05: "error display in the JS or CSS editor, opt-in but on by
// default, with the settable delay before the live refresh"). They are refreshed together with the preview,
// i.e. after the person's own preview delay (Settings → Editor):
// - JavaScript: what the browser itself reports when the preview runs the script — syntax errors and
//   uncaught exceptions, at their line and column (preview runtime → main.ts → here);
// - CSS: syntax errors of the stylesheet, from the CSS parser, with plain messages for the usual mistakes
//   (a missing `;` or `:`, a `{` never closed, one `}` too many).
// Drawn with CodeMirror decorations only: a wavy underline, a bar on the line and the message at the end of the
// line. Marks follow the edits made after they were placed. Pure parts tested in tests/diagnostics_test.ts.
// The message at the line's end is one line, cut short: the whole message (owner 2026-11-14: "see the error
// suggested by typescript on hover, currently I don't have any way of seeing the full error") is in a box when
// the mouse rests on the underlined code or on that message, and by keyboard with "Show the full error at the
// cursor" (showErrorAtCursor) — wrapped, selectable, every error of the spot.

import { type EditorState, type Extension, StateEffect, StateField, type Text } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  hoverTooltip,
  showTooltip,
  type Tooltip,
  WidgetType,
} from "@codemirror/view";
import { cssLanguage } from "@codemirror/lang-css";

export interface CodeError {
  /** 1-based line. */
  line: number;
  /** 1-based column; absent = the whole line. */
  col?: number;
  message: string;
}

/** At most this many errors are drawn per file (the first ones: later ones are often consequences). */
export const MAX_ERRORS = 5;

interface Placed {
  from: number;
  to: number;
  message: string;
}

const setErrors = StateEffect.define<CodeError[]>();
const addErrors = StateEffect.define<CodeError[]>();

/** Where an error is drawn in `doc`: the word at its column, or the line's text. */
export function place(doc: Text, e: CodeError): Placed {
  const line = doc.line(Math.max(1, Math.min(doc.lines, Math.round(e.line) || 1)));
  const text = line.text;
  if (e.col === undefined || !Number.isFinite(e.col)) {
    const start = text.length - text.trimStart().length;
    const end = text.trimEnd().length;
    return end > start
      ? { from: line.from + start, to: line.from + end, message: e.message }
      : { from: line.from, to: line.to, message: e.message };
  }
  let c = Math.max(0, Math.min(text.length, Math.round(e.col) - 1));
  if (c === text.length && c > 0) c--; // at the end of the line: mark the last character
  const word = /^[\w$-]+/.exec(text.slice(c))?.[0].length ?? 1;
  return { from: line.from + c, to: Math.min(line.to, line.from + c + word), message: e.message };
}

class MessageWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  override eq(o: MessageWidget) {
    return o.text === this.text;
  }
  toDOM() {
    // a zero-width box at the line's end, the message overflowing it: the caret at the end of the line (End
    // key: drawn on the widget's side) stays right after the text instead of past the message's margin
    const box = document.createElement("span");
    box.className = "cm-lc-errorMsgBox";
    const s = document.createElement("span");
    s.className = "cm-lc-errorMsg";
    const sr = document.createElement("span");
    sr.className = "sr-only";
    sr.textContent = "Error: ";
    s.append(sr, oneLine(this.text));
    box.append(s);
    return box;
  }
  override ignoreEvent() {
    return false;
  }
}

/** A message on one line, cut short (the whole of it is in the hover box). */
export function oneLine(message: string, max = 140): string {
  const flat = message.replace(/\s*\n\s*/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

const underline = Decoration.mark({ class: "cm-lc-error" });
const errorLine = Decoration.line({ class: "cm-lc-errorLine" });

function decorate(doc: Text, list: readonly Placed[]): DecorationSet {
  const byLine = new Map<number, Placed[]>();
  for (const p of list) {
    const n = doc.lineAt(p.from).number;
    byLine.set(n, [...(byLine.get(n) ?? []), p]);
  }
  const ranges = [];
  for (const [n, items] of byLine) {
    const line = doc.line(n);
    ranges.push(errorLine.range(line.from));
    for (const p of items) if (p.to > p.from) ranges.push(underline.range(p.from, p.to));
    const msg = items.map((p) => p.message).join(" · ");
    ranges.push(Decoration.widget({ widget: new MessageWidget(msg), side: 1 }).range(line.to));
  }
  return Decoration.set(ranges, true);
}

interface ErrorsValue {
  list: Placed[];
  deco: DecorationSet;
}

const errorsField = StateField.define<ErrorsValue>({
  create: () => ({ list: [], deco: Decoration.none }),
  update(v, tr) {
    let list = v.list;
    let changed = false;
    if (tr.docChanged && list.length) {
      list = list.map((p) => {
        const from = tr.changes.mapPos(p.from, 1);
        return { from, to: Math.max(from, tr.changes.mapPos(p.to, -1)), message: p.message };
      });
      changed = true;
    }
    for (const e of tr.effects) {
      if (e.is(setErrors)) {
        list = e.value.slice(0, MAX_ERRORS).map((x) => place(tr.state.doc, x));
        changed = true;
      } else if (e.is(addErrors) && list.length < MAX_ERRORS) {
        list = [...list, ...e.value.map((x) => place(tr.state.doc, x))].slice(0, MAX_ERRORS);
        changed = true;
      }
    }
    if (!changed) return v;
    return { list, deco: list.length ? decorate(tr.state.doc, list) : Decoration.none };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

/**
 * The errors to tell about at `pos`: the ones marked there; at the end of a line (where its message is
 * drawn), every error of that line.
 */
export function errorsAt(
  state: EditorState,
  pos: number,
): { from: number; to: number; messages: string[] } | null {
  const list = state.field(errorsField, false)?.list ?? [];
  if (!list.length) return null;
  const line = state.doc.lineAt(pos);
  const onLine = list.filter((p) => p.from >= line.from && p.from <= line.to);
  const hit = pos === line.to ? onLine : onLine.filter((p) => p.from <= pos && pos <= p.to);
  if (!hit.length) return null;
  return {
    from: Math.min(...hit.map((p) => p.from)),
    to: Math.max(...hit.map((p) => p.to)),
    messages: [...new Set(hit.map((p) => p.message))],
  };
}

/** The box with the whole message(s): wrapped, selectable. */
function errorBox(messages: readonly string[]): HTMLElement {
  const box = document.createElement("div");
  box.className = "cm-lc-errorInfo";
  for (const m of messages) {
    const p = document.createElement("p");
    const sr = document.createElement("span");
    sr.className = "sr-only";
    sr.textContent = "Error: ";
    p.append(sr, m);
    box.append(p);
  }
  return box;
}

/**
 * True when a hover box fits above `pos` inside the editor itself. On the first lines it does not: it would
 * cover the file buttons above the code (and stay there while the mouse crosses it) — it goes below instead.
 */
export function roomAbove(view: EditorView, pos: number, need = 110): boolean {
  const at = view.coordsAtPos(pos);
  return !!at && at.top - view.scrollDOM.getBoundingClientRect().top >= need;
}

/** Mouse resting on the underlined code or on the message at the line's end: the whole message. */
const errorHover = hoverTooltip((view, pos) => {
  const e = errorsAt(view.state, pos);
  if (!e) return null;
  // on the message itself (the line's end): the box at the line's end, under it
  const atEnd = pos === view.state.doc.lineAt(pos).to;
  return {
    pos: atEnd ? pos : e.from,
    end: atEnd ? pos : e.to,
    above: !atEnd && roomAbove(view, e.from),
    create: () => ({ dom: errorBox(e.messages) }),
  };
}, { hoverTime: 350 });

const setErrorTip = StateEffect.define<Tooltip | null>();

/** The box of "Show the full error at the cursor"; closed by any edit, caret move or Escape. */
const errorTipField = StateField.define<Tooltip | null>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setErrorTip)) return e.value;
    return tr.docChanged || tr.selection ? null : v;
  },
  provide: (f) => showTooltip.from(f),
});

/**
 * Keyboard: the whole message of the error(s) at the caret — the ones marked under it, else every error of
 * its line — in a box under the caret, and told to screen readers through `announce`.
 */
export function showErrorAtCursor(view: EditorView, announce: (msg: string) => void = () => {}): boolean {
  if (view.state.field(errorTipField, false) === undefined) return false;
  const pos = view.state.selection.main.head;
  const e = errorsAt(view.state, pos) ?? errorsAt(view.state, view.state.doc.lineAt(pos).to);
  if (!e) {
    announce("No error on this line");
    return true;
  }
  announce(`${e.messages.length === 1 ? "Error" : "Errors"}: ${e.messages.join(" — ")}`);
  view.dispatch({
    effects: setErrorTip.of({ pos, above: false, create: () => ({ dom: errorBox(e.messages) }) }),
  });
  return true;
}

/** The editor extension that draws the errors and shows their whole message (hover, keyboard). */
export const errorDisplay: Extension = [
  errorsField,
  errorHover,
  errorTipField,
  EditorView.domEventHandlers({
    keydown: (e, view) => {
      if (e.key !== "Escape" || !view.state.field(errorTipField)) return false;
      view.dispatch({ effects: setErrorTip.of(null) });
      return true;
    },
  }),
];

/** The effect that replaces the errors shown (for a transaction built by hand; showErrors does it on a view). */
export const errorsEffect = (errors: CodeError[]) => setErrors.of(errors);

/** Replace the errors shown in an editor ([] clears them). */
export function showErrors(view: EditorView, errors: CodeError[]) {
  const cur = view.state.field(errorsField, false);
  if (!cur || (!cur.list.length && !errors.length)) return;
  view.dispatch({ effects: setErrors.of(errors) });
}

/** Add errors to the ones shown (a runtime error reported after the page started). */
export function addShownErrors(view: EditorView, errors: CodeError[]) {
  if (errors.length) view.dispatch({ effects: addErrors.of(errors) });
}

export function errorCount(state: EditorState): number {
  return state.field(errorsField, false)?.list.length ?? 0;
}

// ---------- CSS ----------

const lineCol = (text: string, pos: number) => {
  const before = text.slice(0, pos);
  const line = before.split("\n").length;
  return { line, col: pos - (before.lastIndexOf("\n") + 1) + 1 };
};

/** Syntax errors of a stylesheet, with messages for the common mistakes. */
export function cssErrors(text: string): CodeError[] {
  const out: CodeError[] = [];
  const seen = new Set<string>();
  const push = (key: string, pos: number, message: string, wholeLine = false) => {
    if (seen.has(key) || out.length >= MAX_ERRORS) return;
    seen.add(key);
    const lc = lineCol(text, pos);
    if (out.some((e) => e.line === lc.line)) return;
    out.push(wholeLine ? { line: lc.line, message } : { ...lc, message });
  };
  const tree = cssLanguage.parser.parse(text);
  tree.iterate({
    enter: (n) => {
      if (!n.type.isError) return;
      // a declaration without `;` or `:` is read as a nested rule: report the declaration, not the symptom
      let rule = null;
      for (let p = n.node.parent; p; p = p.parent) {
        if (p.name === "RuleSet" && p.parent?.name === "Block" && p.parent.parent?.name === "RuleSet") {
          rule = p;
          break;
        }
      }
      if (rule) {
        const firstLineEnd = text.indexOf("\n", rule.from);
        const head = text.slice(
          rule.from,
          firstLineEnd < 0 || firstLineEnd > rule.to ? rule.to : firstLineEnd,
        );
        if (head.includes(":")) {
          const at = rule.from + head.trimEnd().length;
          push(`r${rule.from}`, Math.max(rule.from, at - 1), "Missing ; at the end of this line");
        } else {
          const word = /^[\w-]+/.exec(head)?.[0] ?? "";
          push(`r${rule.from}`, rule.from, `Missing : after ${word ? `"${word}"` : "the property name"}`);
        }
        return;
      }
      if (n.from >= text.length) {
        // end of file reached inside a block: point at the `{` that is never closed
        const open: number[] = [];
        for (let i = 0; i < text.length; i++) {
          if (text[i] === "{") open.push(i);
          else if (text[i] === "}") open.pop();
        }
        if (open.length) push("eof", open[open.length - 1], "This { is never closed (missing })");
        else push("eof", Math.max(0, text.trimEnd().length - 1), "Unexpected end of the stylesheet");
        return;
      }
      const tok = text.slice(n.from).match(/^\s*(\S{1,12})/)?.[1] ?? "";
      if (tok.startsWith("}") && n.node.parent?.name === "StyleSheet") {
        push(`e${n.from}`, n.from, "One } too many");
      } else push(`e${n.from}`, n.from, tok ? `Unexpected "${tok}"` : "Syntax error");
    },
  });
  return out.sort((a, b) => a.line - b.line);
}
