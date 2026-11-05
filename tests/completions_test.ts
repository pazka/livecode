// Completions (completions.ts), the crowded-cursor rule (cursors.ts) and the pane list operations
// (panes.ts). CodeMirror's state only, no browser.

import { assert, assertEquals, assertFalse } from "@std/assert";
import { CompletionContext, type CompletionResult, type CompletionSource } from "@codemirror/autocomplete";
import { EditorState, type Extension } from "@codemirror/state";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { javascript } from "@codemirror/lang-javascript";
import {
  abbreviationSnippet,
  browserScopeSource,
  cssNames,
  cssSelectorSource,
  htmlAbbreviationSource,
  htmlAttrValueSource,
  htmlNames,
  jsNames,
  jsSelectorStringSource,
  jsWordSource,
  type PageNames,
  parseAbbreviation,
} from "../src/client/completions.ts";
import { crowdedCarets } from "../src/client/cursors.ts";
import {
  autoDirection,
  closePane,
  dropPane,
  goToPane,
  movePane,
  openBeside,
  resizePair,
  setPaneCount,
} from "../src/client/panes.ts";
import { defaults, sanitize } from "../src/client/settings.ts";

/** Runs a source with the caret at `|` in `doc`. */
async function complete(src: CompletionSource, lang: Extension, doc: string, explicit = false) {
  const pos = doc.indexOf("|");
  const state = EditorState.create({ doc: doc.replace("|", ""), extensions: [lang] });
  return (await src(new CompletionContext(state, pos, explicit))) as CompletionResult | null;
}
const labels = (r: CompletionResult | null) => r?.options.map((o) => o.label) ?? [];

const NAMES: PageNames = { classes: ["card", "hero"], ids: ["main", "top"] };

Deno.test("completions: page names from HTML, CSS and JS — never colours or file names", () => {
  assertEquals(
    htmlNames(`<div class="card big" id='main'><p class=x>t</p></div><style>.st { color: #fff }</style>`),
    { classes: ["card", "big", "x", "st"], ids: ["main"] },
  );
  assertEquals(
    cssNames(".card #main, div.x > .y:hover { color: #fff; background: url(a.png) } @media (x) { .in {} }"),
    { classes: ["card", "x", "y", "in"], ids: ["main"] },
  );
  const js = jsNames(`document.getElementById("app"); el.classList.add("on", "big"); q(".menu > #nav")`);
  assertEquals(js.ids.sort(), ["app", "nav"]);
  assertEquals(js.classes.sort(), ["big", "menu", "on"]);
});

Deno.test("completions: HTML abbreviations (tag, .class, #id) become snippets", () => {
  assertEquals(parseAbbreviation("ul.menu.big#top"), { tag: "ul", classes: ["menu", "big"], id: "top" });
  assertEquals(parseAbbreviation(".card"), { tag: "div", classes: ["card"], id: "" });
  assertEquals(parseAbbreviation("2x"), null);
  assertEquals(abbreviationSnippet({ tag: "div", classes: [], id: "" }), "<div>${}</div>");
  assertEquals(
    abbreviationSnippet({ tag: "section", classes: ["hero"], id: "top" }),
    '<section id="top" class="hero">${}</section>',
  );
  assertEquals(abbreviationSnippet({ tag: "img", classes: [], id: "" }), '<img src="${}" alt="${}">');
  assertEquals(abbreviationSnippet({ tag: "ul", classes: [], id: "" }), "<ul>\n\t<li>${}</li>\n</ul>");
});

Deno.test("completions: HTML tags are offered at the start of a line or after a tag, not mid-line", async () => {
  const h = html();
  const atLine = await complete(htmlAbbreviationSource, h, "<body>\n  di|\n</body>");
  assert(labels(atLine).includes("div"), "div at line start");
  assertEquals(atLine!.from, "<body>\n  ".length);
  assertEquals(await complete(htmlAbbreviationSource, h, "<p>di|</p>"), null, "not after a tag");
  assertEquals(await complete(htmlAbbreviationSource, h, "<p>Hello di|</p>"), null);
  assertEquals(await complete(htmlAbbreviationSource, h, `<div class="di|"></div>`), null);
  assertEquals(await complete(htmlAbbreviationSource, h, "<style>\ndi|\n</style>"), null);
  const abbr = await complete(htmlAbbreviationSource, h, "\nul.menu|");
  assertEquals(labels(abbr), ["ul.menu"]);
});

Deno.test("completions: class / id attributes complete from the stylesheet", async () => {
  const src = htmlAttrValueSource(() => NAMES);
  const r = await complete(src, html(), `<div class="card h|"></div>`);
  assertEquals(labels(r), ["hero"], "already-used classes are left out");
  assertEquals(labels(await complete(src, html(), `<div id="|"></div>`)), ["main", "top"]);
  assertEquals(await complete(src, html(), `<a href="|"></a>`), null);
});

Deno.test("completions: CSS selectors complete classes and ids of the page, never inside declarations", async () => {
  const src = cssSelectorSource(() => NAMES);
  assertEquals(labels(await complete(src, css(), ".c|")), [".card", ".hero"]);
  const self = cssSelectorSource(() => ({ classes: ["ca", "card"], ids: [] }));
  assertEquals(labels(await complete(self, css(), ".ca|")), [".card"], "the half-typed class is not offered");
  assertEquals(labels(await complete(src, css(), "a {}\n#|")), ["#main", "#top"]);
  assertEquals(await complete(src, css(), "a { color: #f| }"), null);
  assertEquals(await complete(src, css(), "a { margin: .5| }"), null);
  assert(labels(await complete(src, css(), "@media (min-width: 1px) {\n  .|\n}")).includes(".card"));
});

Deno.test("completions: JS words of the script, browser globals' members, page names in selector strings", async () => {
  const js = javascript();
  const words = labels(await complete(jsWordSource, js, "const counter = 1;\nfunction render() {}\ncou|"));
  assert(words.includes("counter") && words.includes("render") && words.includes("function"));
  assertFalse(words.includes("cou"), "the word being typed is not offered");
  assertEquals(await complete(jsWordSource, js, "// cou|"), null, "not in comments");
  const sel = jsSelectorStringSource(() => NAMES);
  assertEquals(labels(await complete(sel, js, `document.querySelector(".|")`)), [".card", ".hero"]);
  assertEquals(labels(await complete(sel, js, `document.getElementById("|")`)), ["main", "top"]);
  assertEquals(labels(await complete(sel, js, `el.classList.toggle("|")`)), ["card", "hero"]);
  assertEquals(await complete(sel, js, `alert("|")`), null);
  // (Deno has no `document`: Math stands in for the browser's globals)
  const math = await complete(browserScopeSource, js, "Math.ma|");
  assertEquals(math!.from, "Math.".length);
  assert(labels(math).includes("max"), "members of a global");
  assert(labels(await complete(browserScopeSource, js, "Mat|")).includes("Math"), "globals");
  assertEquals((await complete(browserScopeSource, js, "X| bar X"))!.from, 0, "never before the word");
});

Deno.test("cursors: name chips hide when carets are within 8 characters on a line", () => {
  const p = (line: number, col: number) => ({ line, col });
  assertEquals(crowdedCarets([p(1, 0), p(1, 8), p(1, 30)], null), [true, true, false]);
  assertEquals(crowdedCarets([p(1, 0), p(2, 0)], null), [false, false], "other lines are fine");
  assertEquals(crowdedCarets([p(3, 10)], p(3, 4)), [true], "my own caret counts");
  assertEquals(crowdedCarets([p(3, 10)], p(3, 19)), [false]);
  assertEquals(crowdedCarets([null, p(1, 1)], p(9, 9)), [false, false]);
});

Deno.test("panes: show, hide, reorder, count, resize", () => {
  assertEquals(goToPane(["html"], "html", "css"), ["css"], "one pane: switches like a tab");
  assertEquals(goToPane(["html", "css"], "css", "js"), ["html", "js"], "takes the current file's place");
  assertEquals(goToPane(["html", "css"], "css", "html"), ["html", "css"]);
  assertEquals(openBeside(["html"], "html"), ["html", "css"]);
  assertEquals(openBeside(["css", "html"], "css"), ["css", "js", "html"]);
  assertEquals(openBeside(["html", "css", "js"], "html"), ["html", "css", "js"]);
  assertEquals(setPaneCount(["js", "html", "css"], "html", 1), ["html"]);
  assertEquals(setPaneCount(["js", "html", "css"], "html", 2), ["js", "html"]);
  assertEquals(setPaneCount(["js", "html", "css"], "js", 2), ["js", "html"]);
  assertEquals(setPaneCount(["css"], "css", 2), ["css", "js"]);
  assertEquals(setPaneCount(["css"], "css", 3), ["css", "html", "js"]);
  assertEquals(closePane(["html", "css"], "html"), ["css"]);
  assertEquals(closePane(["html"], "html"), ["html"], "never the last one");
  assertEquals(movePane(["html", "css", "js"], "css", -1), ["css", "html", "js"]);
  assertEquals(movePane(["html", "css"], "html", -1), ["html", "css"]);
  assertEquals(dropPane(["html", "css", "js"], "js", "html", false), ["js", "html", "css"]);
  assertEquals(
    dropPane(["html", "css"], "js", "html", true),
    ["html", "js", "css"],
    "a hidden file is added",
  );
  const sizes = resizePair({ html: 1, css: 1, js: 1 }, "html", "css", 0.75);
  assertEquals([sizes.html, sizes.css, sizes.js], [1.5, 0.5, 1]);
  const min = resizePair({ html: 1, css: 1, js: 1 }, "html", "css", 0);
  assertEquals([min.html, min.css], [0.15, 1.85], "never collapses to nothing");
  assertEquals(autoDirection(1200, 2), "row");
  assertEquals(autoDirection(600, 2), "column");
  assertEquals(autoDirection(300, 1), "row");
});

Deno.test("settings: pane layout is validated", () => {
  const s = sanitize({
    panes: ["css", "css", "nope", "js"],
    paneSizes: { html: 99, css: 2 },
    paneDir: "diag",
  });
  assertEquals(s.panes, ["css", "js"]);
  assertEquals(s.paneSizes, { html: 1, css: 2, js: 1 });
  assertEquals(s.paneDir, "auto");
  assertEquals(sanitize({ panes: [] }).panes, defaults().panes);
});
