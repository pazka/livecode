// Errors shown in the editors (diagnostics.ts) and the mapping of a page line back to the script's line
// (compose.ts). CodeMirror's state only, no browser.

import { assertEquals } from "@std/assert";
import { EditorState, Text } from "@codemirror/state";
import {
  cssErrors,
  errorDisplay,
  errorsAt,
  errorsEffect,
  oneLine,
  place,
} from "../src/client/diagnostics.ts";
import { composeDocument, scriptLine } from "../src/client/compose.ts";

const msgs = (css: string) => cssErrors(css).map((e) => `${e.line}: ${e.message}`);

Deno.test("css errors: plain messages for the usual mistakes, on the right line", () => {
  assertEquals(msgs("a { color: red\n  background: blue; }"), ["1: Missing ; at the end of this line"]);
  assertEquals(msgs("a {\n  color: red;\n  font-size 12px;\n}"), ['3: Missing : after "font-size"']);
  assertEquals(msgs("a { color: red; }}\nb {}"), ["1: One } too many"]);
  assertEquals(msgs("a { color: red; }\nb {\n  margin: 0;"), ["2: This { is never closed (missing })"]);
  assertEquals(
    msgs(".x { margin: 0 auto; }\n@media (min-width: 1px) { b { color: #fff } }\n:root { --a: 1 }"),
    [],
  );
  assertEquals(msgs("a { width: calc(100% - 2px); }\na::before { content: 'x' }"), []);
});

Deno.test("css errors: at most 5, one per line", () => {
  const css = Array.from({ length: 9 }, (_, i) => `.c${i} { color red; }`).join("\n");
  const e = cssErrors(css);
  assertEquals(e.length, 5);
  assertEquals(new Set(e.map((x) => x.line)).size, 5);
});

Deno.test("errors are placed on the word at their column, or on the line's text", () => {
  const doc = Text.of(["let a = 1;", "  foo(bar);", ""]);
  assertEquals(place(doc, { line: 2, col: 3, message: "m" }), { from: 13, to: 16, message: "m" });
  assertEquals(place(doc, { line: 2, message: "m" }), { from: 13, to: 22, message: "m" });
  assertEquals(place(doc, { line: 99, col: 1, message: "m" }).from, doc.line(3).from, "clamped");
  assertEquals(place(doc, { line: 1, col: 11, message: "m" }), { from: 9, to: 10, message: "m" });
});

Deno.test("compose: a line of the page maps back to the script's line", () => {
  const html = composeDocument({
    html: "<p>hi</p>\n<p>two</p>",
    css: "a{}",
    js: "let a = 1;\nlet b = ;\n",
    jsModule: false,
  });
  const lines = html.split("\n");
  const at = lines.findIndex((l) => l.includes("let b = ;")) + 1;
  assertEquals(scriptLine(html, at), 2);
  assertEquals(scriptLine(html, 1), null, "outside the script");
  assertEquals(scriptLine(composeDocument({ html: "x", css: "", js: "", jsModule: false }), 1), null);
  // a syntax error reported against the page with the script's own line (Chrome, parse stopped early)
  const broken = composeDocument({ html: "<p>x</p>", css: "", js: 'f("a"\nlet b = 1;', jsModule: false });
  assertEquals(scriptLine(broken, 1, "SyntaxError: missing ) after argument list"), 1);
  const fine = composeDocument({ html: "<p>x</p>", css: "", js: "f(1);\nlet b = 1;", jsModule: false });
  assertEquals(scriptLine(fine, 1, "SyntaxError: x"), null, "a script that parses is not blamed");
});

Deno.test("full error: the whole message at the marked code, every error of the line at its end", () => {
  const long =
    "Type '{ a: string; }' is not assignable to type 'P'.\n  Property 'b' is missing in type '{ a: string; }'";
  let s = EditorState.create({
    doc: 'let a = 1;\nconst p: P = { a: "x" }; q();\nok();',
    extensions: errorDisplay,
  });
  assertEquals(errorsAt(s, 12), null, "no errors yet");
  s = s.update({
    effects: errorsEffect([
      { line: 2, col: 7, message: long }, // on `p` (11 + 6 = 17..18)
      { line: 2, col: 26, message: "Cannot find name 'q'." }, // on `q` (36..37)
    ]),
  }).state;
  // on the marked word: that error only, whole (not cut, its lines kept)
  assertEquals(errorsAt(s, 17), { from: 17, to: 18, messages: [long] });
  assertEquals(errorsAt(s, 36)?.messages, ["Cannot find name 'q'."]);
  // elsewhere on the line, and on other lines: nothing
  assertEquals(errorsAt(s, 25), null);
  assertEquals(errorsAt(s, 3), null);
  assertEquals(errorsAt(s, s.doc.line(3).to), null);
  // at the line's end (the message drawn there): every error of the line
  assertEquals(errorsAt(s, s.doc.line(2).to)?.messages, [long, "Cannot find name 'q'."]);
  // marks follow the edits: a line inserted above
  s = s.update({ changes: { from: 0, insert: "// top\n" } }).state;
  assertEquals(errorsAt(s, 24)?.messages, [long]);
});

Deno.test("full error: the message at the line's end is one line, cut short", () => {
  assertEquals(
    oneLine("Type A.\n  Property 'b' is missing.\n    Deeper."),
    "Type A. Property 'b' is missing. Deeper.",
  );
  const cut = oneLine("x".repeat(300));
  assertEquals(cut.length, 141);
  assertEquals(cut.endsWith("…"), true);
});
