// Errors shown in the editors (diagnostics.ts) and the mapping of a page line back to the script's line
// (compose.ts). CodeMirror's state only, no browser.

import { assertEquals } from "@std/assert";
import { Text } from "@codemirror/state";
import { cssErrors, place } from "../src/client/diagnostics.ts";
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
