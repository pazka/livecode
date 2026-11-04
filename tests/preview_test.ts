// Preview document composition and the infinite-loop guard.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { guardLoops } from "../src/client/loopguard.ts";
import { composeDocument, RUNTIME } from "../src/client/compose.ts";

Deno.test("loop guard: for / while / do-while get a check, lines are kept", () => {
  const src =
    "for (let i = 0; i < 3; i++) { a(i); }\nwhile (x) y();\ndo { z(); } while (w);\nconst s = 'while(1){}';";
  const out = guardLoops(src);
  assertEquals(out.split("\n").length, src.split("\n").length);
  assertStringIncludes(out, "for (let i = 0; i < 3; i++) {if (__lcLoop(1)) break; a(i); }");
  assertStringIncludes(out, "while (x) {if (__lcLoop(2)) break;y();}");
  assertStringIncludes(out, "do {if (__lcLoop(3)) break; z(); } while (w);");
  assertStringIncludes(out, "'while(1){}'"); // strings untouched
});

Deno.test("loop guard: nested loops and for-of", () => {
  const out = guardLoops("for (const a of b) for (const c of a) n++;");
  assertEquals((out.match(/__lcLoop/g) ?? []).length, 2);
  // still valid JavaScript
  new Function("b", "n", "__lcLoop", out);
});

Deno.test("loop guard: an infinite loop really stops", () => {
  const out = guardLoops("let n = 0; while (true) { n++; } return n;");
  let calls = 0;
  const guard = () => ++calls > 10_000; // stand-in for the runtime's time check
  const n = new Function("__lcLoop", out)(guard);
  assert(n >= 10_000);
});

Deno.test("loop guard: half-typed code is left alone", () => {
  for (const src of ["while (", "for (let i = 0; i <", "do {", "while (x) if ("]) {
    const out = guardLoops(src);
    assert(out.length >= src.length);
  }
});

Deno.test("compose: a fragment stays raw (nothing wrapped or added), runtime first, CSS, then JS", () => {
  const html = composeDocument({
    html: "<h1>Hi</h1>",
    css: "h1{color:red}",
    js: "console.log(1)",
    jsModule: false,
  });
  // raw rendering (owner X.19): no doctype, meta, html/head/body or style of ours
  assert(html.startsWith("<script>"), html.slice(0, 40));
  for (const added of ["<!DOCTYPE", "<meta", "<html", "<head", "<body", "color-scheme"]) {
    assert(!html.toLowerCase().includes(added.toLowerCase()), `added ${added}`);
  }
  assertEquals((html.match(/<style>/g) ?? []).length, 1); // the user's own CSS file, nothing else
  const iRuntime = html.indexOf(RUNTIME.slice(0, 40));
  const iCss = html.indexOf("h1{color:red}");
  const iBody = html.indexOf("<h1>Hi</h1>");
  const iJs = html.indexOf("console.log(1)");
  assert(
    iRuntime > 0 && iRuntime < iCss && iCss < iBody && iBody < iJs,
    `${iRuntime} ${iCss} ${iBody} ${iJs}`,
  );
  assert(html.endsWith("<script>console.log(1)\n//# sourceURL=livecode-script.js\n</script>"));
});

Deno.test("compose: a doctype'd fragment keeps its doctype first (standards mode)", () => {
  const out = composeDocument({ html: "<!doctype html><p>x</p>", css: "p{}", js: "", jsModule: false });
  assert(out.startsWith("<!doctype html><script>"), out.slice(0, 40));
  assert(!out.includes("<meta") && !out.includes("<head"));
});

Deno.test("compose: the runtime adds no styles", () => {
  assert(!/<style|\.style\b|colorScheme|color-scheme|adoptedStyleSheets/.test(RUNTIME));
});

Deno.test("compose: full document keeps its structure; module mode; closing tags escaped", () => {
  const doc = "<!doctype html><html lang=fr><head><title>t</title></head><body><p>x</p></body></html>";
  const out = composeDocument({
    html: doc,
    css: "p::after{content:'</style>'}",
    js: "const s = '</script><!--';",
    jsModule: true,
  });
  assertEquals((out.match(/<head>/g) ?? []).length, 1);
  assert(out.indexOf("<title>t</title>") > out.indexOf("__lcLoop"));
  assertStringIncludes(out, '<script type="module">');
  assertStringIncludes(out, "<\\/script><\\!--");
  assertStringIncludes(out, "'<\\/style>'");
  assert(out.trimEnd().endsWith("</html>"));
  assert(out.indexOf('<script type="module">') < out.lastIndexOf("</body>"));
});

Deno.test("compose: <html> without <head>, and empty files", () => {
  const out = composeDocument({ html: "<html><body>x</body></html>", css: "", js: "", jsModule: false });
  assertStringIncludes(out, "<html><head><script>");
  assert(!out.includes("<style>"));
  assertEquals((out.match(/<script/g) ?? []).length, 1);
});
