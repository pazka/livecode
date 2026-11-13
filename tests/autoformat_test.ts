// Autoformat (autoformat.ts): which lines are pending (the person's own, not someone else's), and what
// formatting them does in HTML, CSS, JavaScript and TypeScript.

import { assertEquals } from "@std/assert";
import { EditorSelection, EditorState, type Extension, type TransactionSpec } from "@codemirror/state";
import { indentUnit } from "@codemirror/language";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { javascript } from "@codemirror/lang-javascript";
import { ySyncAnnotation } from "y-codemirror.next";
import { autoFormat, formatChanges, isOwnEdit, pendingLines } from "../src/client/autoformat.ts";

const make = (doc: string, lang: Extension, cursor = doc.length) =>
  EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [lang, indentUnit.of("  "), autoFormat(true)],
  });

/** The document after formatting what is pending. */
function format(s: EditorState): string {
  return s.update({ changes: formatChanges(s, s.field(pendingLines)) }).state.doc.toString();
}

/** Formats every line, as if the person had just typed the whole file. */
function formatAll(doc: string, lang: Extension, cursor = 0): string {
  const s = make(doc, lang, cursor);
  return s.update({ changes: formatChanges(s, [[0, s.doc.length]]) }).state.doc.toString();
}

const own = (s: EditorState, spec: TransactionSpec) => s.update({ ...spec, userEvent: "input.type" }).state;
const remote = (s: EditorState, spec: TransactionSpec) =>
  s.update({ ...spec, annotations: ySyncAnnotation.of({} as never) }).state;

Deno.test("autoformat: JavaScript re-indented, trailing spaces gone", () => {
  assertEquals(
    formatAll("function f() {\nif (x) {   \ny();\n    }\n}\n", javascript()),
    "function f() {\n  if (x) {\n    y();\n  }\n}\n",
  );
});

Deno.test("autoformat: TypeScript, CSS and HTML (with its <style> and <script>)", () => {
  assertEquals(
    formatAll("interface P {\nx: number;\n      y?: string;\n}\n", javascript({ typescript: true })),
    "interface P {\n  x: number;\n  y?: string;\n}\n",
  );
  assertEquals(formatAll("a {\ncolor: red;  \n     }\n", css()), "a {\n  color: red;\n}\n");
  assertEquals(
    formatAll("<ul>\n<li>one</li>\n      <li>two</li>\n</ul>\n", html()),
    "<ul>\n  <li>one</li>\n  <li>two</li>\n</ul>\n",
  );
  assertEquals(
    formatAll("<script>\nif (a) {\nb();\n}\n</script>\n", html()),
    "<script>\n  if (a) {\n    b();\n  }\n</script>\n",
  );
});

Deno.test("autoformat: verbatim whitespace is kept (template strings, <pre>, <textarea>)", () => {
  const tpl = "const s = `\n    keep   \n  this`;\nif (a) {\n      b();\n}\n";
  assertEquals(formatAll(tpl, javascript()), "const s = `\n    keep   \n  this`;\nif (a) {\n  b();\n}\n");
  const pre = "<div>\n<pre>\n   x  y   \n      z\n</pre>\n<textarea>\n   t\n</textarea>\n</div>\n";
  assertEquals(
    formatAll(pre, html()),
    "<div>\n  <pre>\n   x  y   \n      z\n</pre>\n  <textarea>\n   t\n</textarea>\n</div>\n",
  );
});

Deno.test("autoformat: the caret's line keeps its trailing space and, blank, its indentation", () => {
  // typing "if (a) { " — the space before the next word stays
  const doc = "if (a) { \n    b();\n}";
  assertEquals(formatAll(doc, javascript(), 9), "if (a) { \n  b();\n}");
  // after Enter inside a block: the blank, indented line under the caret is left as it is
  const blank = "if (a) {\n  \n}";
  assertEquals(formatAll(blank, javascript(), 11), blank);
  // a blank line elsewhere loses its spaces
  assertEquals(formatAll("if (a) {\n   \n  b();\n}", javascript(), 0), "if (a) {\n\n  b();\n}");
});

Deno.test("autoformat: only the person's own lines are pending", () => {
  let s = make("if (a) {\nb();\nc();\n}\n", javascript(), 0);
  assertEquals(s.field(pendingLines), []);
  // my edit on line 2
  s = own(s, { changes: { from: 9, insert: "x" }, selection: EditorSelection.cursor(0) });
  assertEquals(format(s), "if (a) {\n  xb();\nc();\n}\n"); // line 3 untouched: not mine
  // remote edits elsewhere move my pending line along; they are not pending themselves
  s = remote(s, { changes: { from: 0, insert: "// top\n" } });
  assertEquals(format(s), "// top\nif (a) {\n  xb();\nc();\n}\n");
});

Deno.test("autoformat: a line someone else edits is theirs, not formatted", () => {
  let s = make("if (a) {\nb();\nc();\n}\n", javascript(), 0);
  s = own(s, { changes: [{ from: 9, insert: "x" }, { from: 14, insert: "y" }] }); // lines 2 and 3
  s = remote(s, { changes: { from: 17, insert: "z" } }); // someone types on line 3 too
  assertEquals(format(s), "if (a) {\n  xb();\nycz();\n}\n");
});

Deno.test("autoformat: undo, redo and the format itself are not edits to format again", () => {
  const s = make("x", javascript());
  for (const ev of ["undo", "redo", "format.auto", "select"]) {
    assertEquals(isOwnEdit(s.update({ changes: { from: 0, insert: "a" }, userEvent: ev })), false, ev);
  }
  for (const ev of ["input.type", "input.paste", "delete.backward", "move.line"]) {
    assertEquals(isOwnEdit(s.update({ changes: { from: 0, insert: "a" }, userEvent: ev })), true, ev);
  }
  assertEquals(isOwnEdit(s.update({ selection: EditorSelection.cursor(0), userEvent: "input" })), false);
});
