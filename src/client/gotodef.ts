// Go to the code of a name (owner 2026-11-15: "go to the code when I click on a reference with the usual
// control, it can be cmd click or alt click depending on the keymap and mac or windows machine").
//
// Click with the keymap's gesture (keymaps.ts `mouse.goto`: Ctrl/⌘+click in VS Code and JetBrains, Alt+click in
// Sublime / Vim / Emacs, where Ctrl/⌘+click is "add a cursor"), or the "Go to the code" command (VS Code and
// Sublime F12, JetBrains Ctrl/⌘+B, Emacs M-., Vim gd). While the gesture's key is held, the name under the
// mouse is underlined.
// - The script (JavaScript or TypeScript): the TypeScript service finds the declaration — a function, a
//   variable, a class, a type, a property, a parameter. On the declaration itself: its next use (they cycle).
//   The browser's own names (`document`, `Math` …) have no code here: a message says so.
// - Names of the page, across the three files: a class or an id in a selector string of the script
//   (`querySelector(".card")`, `getElementById("out")`, `classList.add("on")`) or in a selector of the
//   stylesheet goes to the element in the HTML; `class="…"` / `id="…"` in the HTML goes to the stylesheet's
//   rule (else to the script that names it); `var(--gap)` goes to where `--gap` is set.
// Nothing found with the mouse: the click stays what it was (a cursor added or placed), nothing else happens.
// Pure parts (nameAt, findName) are tested in tests/gotodef_test.ts.

import {
  type EditorSelection,
  type EditorState,
  type Extension,
  Facet,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { htmlLanguage } from "@codemirror/lang-html";
import { cssLanguage } from "@codemirror/lang-css";
import type { FileId } from "../shared/protocol.ts";
import { type MouseMods, mouseMods } from "./keys.ts";
import { tsClient } from "./ts/client.ts";

type Tree = ReturnType<typeof syntaxTree>;
type SyntaxNode = ReturnType<Tree["resolveInner"]>;

export type FileTexts = (f: FileId) => string;

/** A place in one of the three files. */
export interface Target {
  file: FileId;
  from: number;
  to: number;
}

/** A name of the page under the cursor: a class, an id, or a custom property. */
export interface PageName {
  kind: "class" | "id" | "var";
  name: string;
  from: number;
  to: number;
}

const NAME = /[\w-]/;
function wordAround(text: string, pos: number): { from: number; to: number; word: string } | null {
  let from = pos, to = pos;
  while (from > 0 && NAME.test(text[from - 1])) from--;
  while (to < text.length && NAME.test(text[to])) to++;
  return to > from ? { from, to, word: text.slice(from, to) } : null;
}

/** Attributes whose value is an id of the page. */
const ID_ATTRS = new Set([
  "id",
  "for",
  "aria-controls",
  "aria-labelledby",
  "aria-describedby",
  "list",
  "form",
]);

/** The page's name at `pos` of a file (`tree`: the file's syntax tree), or null. */
export function nameAt(file: FileId, tree: Tree, text: string, pos: number): PageName | null {
  for (const side of [1, -1] as const) {
    const found = nameIn(file, tree.resolveInner(pos, side), text, pos);
    if (found) return found;
  }
  return null;
}

function nameIn(file: FileId, at: SyntaxNode, text: string, pos: number): PageName | null {
  for (let n: SyntaxNode | null = at; n; n = n.parent) {
    // a stylesheet (the CSS file, or a <style> of the HTML)
    if (n.name === "ClassName") {
      return { kind: "class", name: text.slice(n.from, n.to), from: n.from, to: n.to };
    }
    if (n.name === "IdName") {
      const name = text.slice(n.from, n.to).replace(/^#/, "");
      return { kind: "id", name, from: n.to - name.length, to: n.to };
    }
    if (n.name === "VariableName" && file !== "js" && text.slice(n.from, n.to).startsWith("--")) {
      // `var(--x)`: a use; the declaration (`--x: 1`) is where it leads, not a link itself
      if (n.parent?.name === "Declaration" && n.parent.firstChild?.from === n.from) return null;
      return { kind: "var", name: text.slice(n.from, n.to), from: n.from, to: n.to };
    }
    // HTML: class="a b", id="x", for="x", href="#x"
    if (n.name === "AttributeValue" || n.name === "UnquotedAttributeValue") {
      const attr = n.parent?.getChild("AttributeName");
      const w = wordAround(text, pos);
      if (!attr || !w || w.from < n.from || w.to > n.to) return null;
      const name = text.slice(attr.from, attr.to).toLowerCase();
      if (name === "class") return { kind: "class", name: w.word, from: w.from, to: w.to };
      if (ID_ATTRS.has(name)) return { kind: "id", name: w.word, from: w.from, to: w.to };
      if (name === "href" && text[w.from - 1] === "#") {
        return { kind: "id", name: w.word, from: w.from, to: w.to };
      }
      return null;
    }
    // the script: a selector in a string, or the argument of a call that takes a class / an id
    if (file === "js" && (n.name === "String" || n.name === "TemplateString")) {
      const w = wordAround(text, pos);
      if (!w || w.from <= n.from || w.to >= n.to) return null;
      const before = text[w.from - 1];
      if (before === ".") return { kind: "class", name: w.word, from: w.from, to: w.to };
      if (before === "#") return { kind: "id", name: w.word, from: w.from, to: w.to };
      const call = text.slice(Math.max(0, n.from - 80), n.from);
      if (/getElementById\(\s*$/.test(call)) return { kind: "id", name: w.word, from: w.from, to: w.to };
      if (/(getElementsByClassName\(\s*|classList\.\w+\((?:[^()]*,)?\s*)$/.test(call)) {
        return { kind: "class", name: w.word, from: w.from, to: w.to };
      }
      return null;
    }
  }
  return null;
}

/** Where a class or an id is given to an element of the HTML: the name inside `class="…"` / `id="…"`. */
function inHtml(kind: "class" | "id", name: string, html: string): Target | null {
  let out: Target | null = null;
  htmlLanguage.parser.parse(html).iterate({
    enter: (n) => {
      if (out) return false;
      if (n.name !== "Attribute") return;
      const attr = n.node.getChild("AttributeName");
      const value = n.node.getChild("AttributeValue") ?? n.node.getChild("UnquotedAttributeValue");
      if (!attr || !value || html.slice(attr.from, attr.to).toLowerCase() !== kind) return false;
      const v = html.slice(value.from, value.to);
      for (let i = v.indexOf(name); i >= 0; i = v.indexOf(name, i + 1)) {
        const b = v[i - 1] ?? "", a = v[i + name.length] ?? "";
        if (NAME.test(b) || NAME.test(a)) continue;
        out = { file: "html", from: value.from + i, to: value.from + i + name.length };
        break;
      }
      return false;
    },
  });
  return out;
}

/** The first selector of the stylesheet that names the class / the id; the first `--x:` for a property. */
function inCss(kind: PageName["kind"], name: string, css: string): Target | null {
  let out: Target | null = null;
  cssLanguage.parser.parse(css).iterate({
    enter: (n) => {
      if (out) return false;
      const t = () => css.slice(n.from, n.to);
      if (kind === "class" && n.name === "ClassName" && t() === name) {
        out = { file: "css", from: n.from, to: n.to };
      } else if (kind === "id" && n.name === "IdName" && t().replace(/^#/, "") === name) {
        out = { file: "css", from: n.to - name.length, to: n.to };
      } else if (
        kind === "var" && n.name === "VariableName" && t() === name &&
        n.node.parent?.name === "Declaration" &&
        n.node.parent.firstChild?.from === n.from
      ) out = { file: "css", from: n.from, to: n.to };
    },
  });
  return out;
}

/** The first place of the script that names the class / the id (a selector string, a call's argument). */
function inScript(kind: "class" | "id", name: string, js: string): Target | null {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const res = kind === "id"
    ? [
      new RegExp(`getElementById\\(\\s*["'\`](${esc})["'\`]`),
      new RegExp(`["'\`][^"'\`\\n]*#(${esc})(?![\\w-])`),
    ]
    : [
      new RegExp(`["'\`][^"'\`\\n]*\\.(${esc})(?![\\w-])`),
      new RegExp(`(?:classList\\.\\w+|getElementsByClassName)\\([^)\\n]*["'\`](${esc})["'\`]`),
    ];
  let best: Target | null = null;
  for (const re of res) {
    const m = re.exec(js);
    if (!m) continue;
    const from = m.index + m[0].lastIndexOf(m[1]);
    if (!best || from < best.from) best = { file: "js", from, to: from + name.length };
  }
  return best;
}

/**
 * Where a name of the page leads from `file`: from the script or the stylesheet to the element in the HTML
 * (the script: else the stylesheet's rule); from the HTML to the stylesheet's rule, else the script.
 */
export function findName(n: PageName, file: FileId, texts: FileTexts): Target | null {
  if (n.kind === "var") return inCss("var", n.name, texts("css"));
  const kind = n.kind;
  const order: FileId[] = file === "html" ? ["css", "js"] : file === "css" ? ["html", "js"] : ["html", "css"];
  for (const f of order) {
    const t = f === "html"
      ? inHtml(kind, n.name, texts("html"))
      : f === "css"
      ? inCss(kind, n.name, texts("css"))
      : inScript(kind, n.name, texts("js"));
    if (t) return t;
  }
  return null;
}

// ---------- the editor ----------

export interface GotoConfig {
  file: FileId;
  /** The script's language now. */
  lang: () => "js" | "ts";
  texts: FileTexts;
  /** Shows a place (another file: its tab opens) with the caret on it. */
  open: (t: Target) => void;
}

const gotoConfig = Facet.define<GotoConfig, GotoConfig | null>({ combine: (v) => v[0] ?? null });

/** What a place leads to: a target, a message (nothing to open, and why), or nothing at all. */
type Found = { target: Target } | { message: string } | null;

async function resolve(state: EditorState, pos: number): Promise<Found> {
  const cfg = state.facet(gotoConfig);
  if (!cfg) return null;
  const text = state.doc.toString();
  const name = nameAt(cfg.file, syntaxTree(state), text, pos);
  if (name) {
    const target = findName(name, cfg.file, cfg.texts);
    if (target) return { target };
    const what = name.kind === "var" ? name.name : `${name.kind === "class" ? "." : "#"}${name.name}`;
    return { message: `${what} is not in the other files` };
  }
  if (cfg.file !== "js") return null;
  let d;
  try {
    d = await tsClient().call("definition", text, pos, cfg.lang());
  } catch {
    return { message: "TypeScript is not available" };
  }
  if (!d) return null;
  if (d.kind === "library") return { message: `${d.name} is the browser's own: no code to open here` };
  if (d.kind === "definition") return { target: { file: "js", from: d.from, to: d.to } };
  if (!d.ranges.length) return { message: "This is its only use" };
  const next = d.ranges.find((r) => r.from > pos) ?? d.ranges[0];
  return { target: { file: "js", ...next } };
}

/** Keyboard: go to the code of the name at the caret. */
export function goToDefinition(view: EditorView, say: (m: string) => void = () => {}): boolean {
  const cfg = view.state.facet(gotoConfig);
  if (!cfg) return false;
  const doc = view.state.doc;
  resolve(view.state, view.state.selection.main.head).then((found) => {
    if (view.state.doc !== doc) return;
    if (!found) say("Nothing to go to here");
    else if ("message" in found) say(found.message);
    else cfg.open(found.target);
  });
  return true;
}

const setLink = StateEffect.define<{ from: number; to: number } | null>();
const linkMark = Decoration.mark({ class: "cm-lc-link" });

/** The name underlined while the gesture's key is held over it. */
const linkField = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setLink)) return e.value;
    return v && tr.docChanged ? null : v;
  },
  provide: (f) =>
    EditorView.decorations.from(
      f,
      (v) => v && v.to > v.from ? Decoration.set([linkMark.range(v.from, v.to)]) : Decoration.none,
    ),
});

/** The name (letters, digits, `_`, `$`, `-` outside the script) under a point of the editor, if any. */
function nameUnder(view: EditorView, x: number, y: number): { from: number; to: number } | null {
  const pos = view.posAtCoords({ x, y }, false);
  if (pos === null) return null;
  const line = view.state.doc.lineAt(pos);
  const char = view.state.facet(gotoConfig)?.file === "js" ? /[\w$]/ : NAME;
  let from = pos - line.from, to = from;
  while (from > 0 && char.test(line.text[from - 1])) from--;
  while (to < line.text.length && char.test(line.text[to])) to++;
  if (to === from) return null;
  // the point is on the name itself, not on the empty space after the line's end
  const end = view.coordsAtPos(line.from + to);
  if (end && x > end.right + 2) return null;
  return { from: line.from + from, to: line.from + to };
}

/**
 * The mouse: a click with `mods` on a name goes to its code. The click itself is left to do what it does
 * (place or add a cursor); when it leads somewhere, the selection is put back as it was and the place opens.
 */
export function gotoMouse(mods: MouseMods): Extension {
  let down: { x: number; y: number; pos: number; before: EditorSelection } | null = null;
  const clearLink = (view: EditorView) => {
    if (view.state.field(linkField, false)) view.dispatch({ effects: setLink.of(null) });
  };
  return [
    linkField,
    EditorView.domEventHandlers({
      mousedown: (e, view) => {
        down = null;
        if (e.button !== 0 || e.detail > 1 || !mouseMods(e, mods)) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
        if (pos !== null) down = { x: e.clientX, y: e.clientY, pos, before: view.state.selection };
        return false;
      },
      mouseup: (e, view) => {
        const d = down;
        down = null;
        if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return false; // a drag: not a click
        const cfg = view.state.facet(gotoConfig);
        const doc = view.state.doc;
        if (!cfg) return false;
        resolve(view.state, d.pos).then((found) => {
          if (!found || "message" in found || view.state.doc !== doc) return;
          clearLink(view);
          view.dispatch({ selection: d.before }); // the click's own cursor is taken back: this was a jump
          cfg.open(found.target);
        });
        return false;
      },
      mousemove: (e, view) => {
        const cur = view.state.field(linkField, false) ?? null;
        const at = mouseMods(e, mods) && e.buttons === 0 ? nameUnder(view, e.clientX, e.clientY) : null;
        if (at?.from !== cur?.from || at?.to !== cur?.to) view.dispatch({ effects: setLink.of(at) });
        return false;
      },
      mouseleave: (_e, view) => {
        clearLink(view);
        return false;
      },
      keyup: (_e, view) => {
        clearLink(view);
        return false;
      },
      blur: (_e, view) => {
        clearLink(view);
        return false;
      },
    }),
  ];
}

/** The editor extension: what "go to the code" needs to know about the file. */
export const gotoDefinitionConfig = (config: GotoConfig): Extension => gotoConfig.of(config);
