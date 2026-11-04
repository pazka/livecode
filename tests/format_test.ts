// Format (VS Code Shift+Alt+F / JetBrains Ctrl+Alt+L): whole file re-indented + trailing spaces trimmed
// without a selection; only the selected lines with one. Runs CodeMirror's state, no browser.

import { assertEquals } from "@std/assert";
import { EditorSelection, EditorState, type Extension, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { indentUnit } from "@codemirror/language";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { javascript } from "@codemirror/lang-javascript";
import { formatCode } from "../src/client/commands.ts";

function run(doc: string, lang: Extension, sel?: [number, number]): string {
  let state = EditorState.create({
    doc,
    extensions: [lang, indentUnit.of("  "), EditorState.tabSize.of(2)],
    selection: sel ? EditorSelection.single(sel[0], sel[1]) : undefined,
  });
  const view = {
    get state() {
      return state;
    },
    dispatch: (spec: TransactionSpec) => (state = state.update(spec).state),
  };
  formatCode(view as unknown as EditorView);
  return state.doc.toString();
}

Deno.test("format: JS whole file", () => {
  assertEquals(
    run("function f() {\nif (x) {\n      return 1;   \n}\n}", javascript()),
    "function f() {\n  if (x) {\n    return 1;\n  }\n}",
  );
});

Deno.test("format: CSS whole file", () => {
  assertEquals(
    run("body {\ncolor: red;  \n    margin: 0;\n}", css()),
    "body {\n  color: red;\n  margin: 0;\n}",
  );
});

Deno.test("format: HTML whole file, blank lines emptied", () => {
  assertEquals(
    run("<main>\n<p>x</p>\n   \n      <p>y</p>\n</main>", html()),
    "<main>\n  <p>x</p>\n\n  <p>y</p>\n</main>",
  );
});

Deno.test("format: with a selection only the selected lines move", () => {
  const doc = "{\nx;\ny;\n}";
  assertEquals(run(doc, javascript(), [2, 3]), "{\n  x;\ny;\n}");
});
