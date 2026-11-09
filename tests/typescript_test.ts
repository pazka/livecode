// TypeScript for the script: the language service (completions from the DOM types and the room's own
// interfaces / classes / types, the type at a position, type errors), the JavaScript the preview runs and
// the way back from its lines to the TypeScript (source map), the console relabelling, and the lib files.

import { assert, assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import ts from "typescript";
import { LIBS } from "../src/client/ts/libs.gen.ts";
import { LIB_ROOTS, ScriptService } from "../src/client/ts/service.ts";
import { decodeMappings, sourceLookup } from "../src/client/ts/sourcemap.ts";
import { boostOf } from "../src/client/ts/client.ts";
import { relabel } from "../src/client/preview.ts";
import { guardLoops } from "../src/client/loopguard.ts";

const service = new ScriptService(ts, LIBS);

/** Text with a `§` marking the caret → the text without it and the caret's offset. */
function caret(src: string): [string, number] {
  const at = src.indexOf("§");
  return [src.slice(0, at) + src.slice(at + 1), at];
}

const names = (src: string, trigger?: string) => {
  const [text, pos] = caret(src);
  const r = service.completions(text, pos, trigger);
  return { r, names: new Set(r?.entries.map((e) => e.name) ?? []) };
};

Deno.test("typescript: the lib files are there (esnext + dom and everything they reference)", () => {
  for (const f of LIB_ROOTS) assert(f in LIBS, f);
  for (const f of ["lib.es5.d.ts", "lib.es2015.promise.d.ts", "lib.decorators.d.ts"]) assert(f in LIBS, f);
  assertStringIncludes(LIBS["lib.dom.d.ts"], "interface HTMLElement");
  // every reference resolves inside the set
  for (const [name, text] of Object.entries(LIBS)) {
    for (const m of text.matchAll(/\/\/\/\s*<reference\s+lib="([^"]+)"/g)) {
      assert(`lib.${m[1].toLowerCase()}.d.ts` in LIBS, `${name} → ${m[1]}`);
    }
  }
});

Deno.test("typescript: members of the DOM types (document., an element, a canvas context)", () => {
  const doc = names("document.§", ".");
  for (const n of ["getElementById", "querySelector", "body", "createElement"]) assert(doc.names.has(n), n);
  const el = names('const b = document.querySelector("button")!;\nb.§', ".");
  for (const n of ["disabled", "addEventListener", "classList", "click"]) assert(el.names.has(n), n);
  const ctx = names('const c = document.createElement("canvas").getContext("2d")!;\nc.§', ".");
  for (const n of ["fillRect", "beginPath", "strokeStyle"]) assert(ctx.names.has(n), n);
  assert(!ctx.names.has("getElementById"));
});

Deno.test("typescript: the room's own interfaces, types and classes complete", () => {
  const src = `interface Point { x: number; y: number; label?: string }
type Shape = { kind: "circle"; r: number } | { kind: "square"; side: number };
class Counter { count = 0; increment(by = 1) { this.count += by; } }
const p: Point = { x: 1, y: 2 };
const c = new Counter();
`;
  const point = names(src + "p.§", ".");
  assertEquals([...point.names].sort(), ["label", "x", "y"]);
  assertEquals(point.r!.entries.find((e) => e.name === "label")!.optional, true);
  const counter = names(src + "c.§", ".");
  assertEquals([...counter.names].sort(), ["count", "increment"]);
  // a type name where a type goes
  const typed = names(src + "let s: Sh§");
  assert(typed.names.has("Shape"));
  assertEquals(typed.r!.from, src.length + "let s: ".length); // replaces the word typed so far
  // a discriminated union's tag values
  const kind = names(src + 'const sh: Shape = { kind: "§" };', '"');
  assert(kind.names.has("circle") && kind.names.has("square"));
});

Deno.test('typescript: event names inside addEventListener("…") replace what is typed', () => {
  const src = 'window.addEventListener("cl§", () => {});';
  const { r, names: n } = names(src);
  assert(n.has("click"));
  assert(n.has("keydown"));
  const [text] = caret(src);
  assertEquals(text.slice(r!.from, r!.to), "cl");
});

Deno.test("typescript: globals rank after the script's own names", () => {
  const { r } = names("const total = 3;\n§");
  const total = r!.entries.find((e) => e.name === "total")!;
  const win = r!.entries.find((e) => e.name === "window")!;
  assert(boostOf(total) > boostOf(win));
  assert(boostOf({ sort: "11", deprecated: true }) < boostOf(win));
});

Deno.test("typescript: details and the type at a position", () => {
  const [text, pos] = caret("document.§");
  const d = service.details(text, pos, "getElementById");
  assertExists(d);
  assertStringIncludes(d.display, "getElementById(elementId: string): HTMLElement | null");
  assert(d.docs.length > 10);
  const src = "interface Point { x: number }\nconst p: Point = { x: 1 };\np.x;";
  const t = service.typeAt(src, src.lastIndexOf("p.x"));
  assertExists(t);
  assertEquals(t.display, "const p: Point");
  assertEquals(src.slice(t.from, t.to), "p");
});

Deno.test("typescript: type errors at their line and column, plain messages", () => {
  const src = `const n: number = "a";
const btn = document.getElementById("btn");
btn.click();
interface P { x: number }
const p: P = { x: 1, y: 2 };
`;
  const errs = service.errors(src);
  assertEquals(errs.map((e) => [e.line, e.col]), [[1, 7], [3, 1], [5, 22]]);
  assertStringIncludes(errs[0].message, "Type 'string' is not assignable to type 'number'");
  assertStringIncludes(errs[1].message, "'btn' is possibly 'null'");
  assertStringIncludes(errs[2].message, "'y' does not exist in type 'P'");
});

Deno.test("typescript: top-level names never clash with the DOM's globals; URL imports are allowed", () => {
  const src = `import confetti from "https://esm.sh/canvas-confetti";
const name = "me";
let status = 1;
function close() {}
confetti();
`;
  assertEquals(service.errors(src), []);
});

Deno.test("typescript: syntax errors are reported", () => {
  const errs = service.errors("const a = ;\n");
  assertEquals(errs.length, 1);
  assertEquals(errs[0].line, 1);
});

Deno.test("typescript: transpile removes the types and nothing else; the map leads back", () => {
  const src = `interface Point {
  x: number;
  y: number;
}

const p: Point = { x: 1, y: 2 };
function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
console.log(dist(p, { x: 4, y: 6 }));
`;
  const out = service.transpile(src);
  assert(!out.js.includes("interface"));
  assert(!out.js.includes(": Point"));
  assert(!out.js.includes("sourceMappingURL"));
  // the JavaScript runs
  const logs: unknown[] = [];
  new Function("console", out.js)({ log: (v: unknown) => logs.push(v) });
  assertEquals(logs, [5]);
  // its lines lead back to the TypeScript ones
  const back = sourceLookup(out.map);
  const jsLines = out.js.split("\n");
  const at = (needle: string) => jsLines.findIndex((l) => l.includes(needle)) + 1;
  assertEquals(back(at("const p ="), 0)?.line, 6);
  assertEquals(back(at("Math.hypot"), 0)?.line, 8);
  assertEquals(back(at("console.log"), 0)?.line, 10);
  // a column on the line: `b.x` in `Math.hypot(a.x - b.x …)`
  const l = at("Math.hypot");
  const col = jsLines[l - 1].indexOf("b.x") + 1;
  const tsLine = src.split("\n")[7];
  assertEquals(back(l, col), { line: 8, col: tsLine.indexOf("b.x") + 1 });
  // the line TypeScript adds ("use strict") maps to nothing before it
  assertEquals(back(1, 0), null);
});

Deno.test("typescript: a module script keeps its imports", () => {
  const out = service.transpile(
    'import type { A } from "./a";\nimport x from "https://esm.sh/x";\nconst a: A = x;\n',
  );
  assertStringIncludes(out.js, 'import x from "https://esm.sh/x";');
  assert(!out.js.includes("./a"));
});

Deno.test("typescript: the loop guard keeps working on the JavaScript, at the TypeScript line", () => {
  const src = "type N = number;\nlet n: N = 0;\nwhile (true) {\n  n++;\n}\n";
  const out = service.transpile(src);
  const guarded = guardLoops(out.js);
  assertEquals(guarded.split("\n").length, out.js.split("\n").length);
  const m = guarded.match(/__lcLoop\((\d+)\)/)!;
  assertEquals(sourceLookup(out.map)(Number(m[1]), 0)?.line, 3);
});

Deno.test("sourcemap: VLQ decoding (negative deltas, several segments, empty lines)", () => {
  // "AAAA" = [0,0,0,0]; "SAAS" = [9,0,0,9]; "AACD" = [0,0,1,-1]
  const lines = decodeMappings("AAAA,SAAS;;AACD");
  assertEquals(lines, [[[0, 0, 0], [9, 0, 9]], [], [[0, 1, 8]]]);
  const back = sourceLookup(JSON.stringify({ version: 3, mappings: "AAAA,SAAS;;AACD" }));
  assertEquals(back(1, 12), { line: 1, col: 12 }); // 2 past the second segment (gen col 9 → src col 9)
  assertEquals(back(2, 0), { line: 1, col: 0 }); // a line without mapping: the one above
  assertEquals(sourceLookup("not json")(1, 1), null);
});

Deno.test('console: "(JS line N)" of a TypeScript run names the TypeScript line', () => {
  const built = { html: "", label: "TS", toSource: (l: number) => (l === 7 ? { line: 4, col: 0 } : null) };
  assertEquals(relabel("Loop stopped (JS line 7). Fix it", built), "Loop stopped (TS line 4). Fix it");
  assertEquals(relabel("x is not defined (JS line 9)", built), "x is not defined (JS line 9)");
});

Deno.test("typescript: the pinned compiler is one that runs in a page (6.x, JavaScript, with a language service)", () => {
  // 7.x is the native (Go) TypeScript: no browser build, no in-page language service. Don't bump to it.
  assert(/^6\./.test(ts.version), `typescript ${ts.version}`);
  assertEquals(typeof ts.createLanguageService, "function");
  assertEquals(typeof ts.transpileModule, "function");
});

Deno.test("typescript: rename is scope-aware (another x elsewhere is not touched)", () => {
  const src = `let count = 0;
function add(n: number) {
  count += n;
  return count;
}
function other() {
  const count = "mine";
  return count;
}
`;
  const r = service.rename(src, src.indexOf("count"));
  assert(r.ok);
  assertEquals(r.name, "count");
  // the module-level count: its declaration and the 2 uses in add(), not other()'s own count
  assertEquals(r.ranges.map((x) => src.slice(0, x.from).split("\n").length), [1, 3, 4]);
});

Deno.test("typescript: rename of an interface property follows its uses; DOM names can't be renamed", () => {
  const src = "interface P { label: string }\nconst p: P = { label: 'a' };\np.label.length;\n";
  const r = service.rename(src, src.indexOf("label"));
  assert(r.ok);
  assertEquals(r.ranges.length, 3);
  const dom = "document.getElementById('x');";
  const no = service.rename(dom, dom.indexOf("getElementById") + 2);
  assert(!no.ok);
});

Deno.test("typescript: rename works in a JavaScript room too", () => {
  const src =
    "const btn = document.querySelector('button');\nbtn.addEventListener('click', () => btn.blur());\n";
  const r = service.rename(src, src.indexOf("btn"), "js");
  assert(r.ok);
  assertEquals(r.ranges.length, 3);
  // and the TypeScript file is untouched by it (completions still from the TS text)
  assert(service.completions("document.", 9, ".")!.entries.some((e) => e.name === "body"));
});
