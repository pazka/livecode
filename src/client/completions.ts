// Extra completions, on top of what each language package already offers (CSS properties/values, HTML tags
// after `<`, JS keywords/snippets/locals):
// - JavaScript: the browser's own globals and their members (`document.`, `Math.`, `console.` … read from
//   this window, which has the same APIs as the preview), the words already written in the script, and the
//   page's classes / ids inside `querySelector("…")`, `getElementById("…")`, `classList.add("…")` …
// - HTML: tag abbreviations typed as text (`div` → `<div></div>`, `ul.menu` → `<ul class="menu">…`,
//   `section#top.hero` … at the start of a line), and classes / ids from the stylesheet inside `class="…"` / `id="…"`.
// - CSS: `.` / `#` selectors complete the classes and ids used in the HTML (and the script).
// Pure (state in, options out): tested in tests/completions_test.ts.

import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
  snippetCompletion,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { cssLanguage } from "@codemirror/lang-css";
import { htmlLanguage } from "@codemirror/lang-html";
import { javascriptLanguage, scopeCompletionSource } from "@codemirror/lang-javascript";
import type { FileId } from "../shared/protocol.ts";

/** The current text of every file (the other editors' completions read it). */
export type FileTexts = (f: FileId) => string;

type Tree = ReturnType<typeof syntaxTree>;
type SyntaxNode = ReturnType<Tree["resolveInner"]>;

export interface PageNames {
  classes: string[];
  ids: string[];
}

const one = <T>(fn: (s: string) => T) => {
  let key: string | null = null;
  let val: T;
  return (s: string): T => {
    if (s !== key) {
      key = s;
      val = fn(s);
    }
    return val;
  };
};

const CLASS_RE = /^-?[A-Za-z_][\w-]*$/;
const unquote = (s: string) => s.replace(/^["']|["']$/g, "");

/** Classes and ids of an HTML text (attributes, and the selectors of its `<style>` blocks). */
export function htmlNames(text: string): PageNames {
  const classes = new Set<string>();
  const ids = new Set<string>();
  const tree = htmlLanguage.parser.parse(text);
  tree.iterate({
    enter: (n) => {
      if (n.name === "Attribute") {
        const name = n.node.getChild("AttributeName");
        const value = n.node.getChild("AttributeValue") ?? n.node.getChild("UnquotedAttributeValue");
        if (!name || !value) return false;
        const attr = text.slice(name.from, name.to).toLowerCase();
        const v = unquote(text.slice(value.from, value.to));
        if (attr === "class") { for (const c of v.split(/\s+/)) if (CLASS_RE.test(c)) classes.add(c); }
        if (attr === "id" && CLASS_RE.test(v.trim())) ids.add(v.trim());
        return false;
      }
      collectCssNode(text, n.name, n.from, n.to, classes, ids);
    },
  });
  return { classes: [...classes], ids: [...ids] };
}

/** Classes and ids named in a stylesheet's selectors (never `#fff` colours or `url(a.png)`). */
export function cssNames(text: string): PageNames {
  const classes = new Set<string>();
  const ids = new Set<string>();
  cssLanguage.parser.parse(text).iterate({
    enter: (n) => collectCssNode(text, n.name, n.from, n.to, classes, ids),
  });
  return { classes: [...classes], ids: [...ids] };
}

function collectCssNode(
  text: string,
  name: string,
  from: number,
  to: number,
  cl: Set<string>,
  ids: Set<string>,
) {
  if (name === "ClassName") {
    const c = text.slice(from, to);
    if (CLASS_RE.test(c)) cl.add(c);
  } else if (name === "IdName") {
    const id = text.slice(from, to).replace(/^#/, "");
    if (CLASS_RE.test(id)) ids.add(id);
  }
}

/** Classes and ids a script refers to (`classList.add("x")`, `getElementById("y")`, `"#z"` selectors). */
export function jsNames(text: string): PageNames {
  const classes = new Set<string>();
  const ids = new Set<string>();
  for (const m of text.matchAll(/getElementById\(\s*["'`]([\w-]+)["'`]/g)) ids.add(m[1]);
  for (const m of text.matchAll(/classList\.(?:add|remove|toggle|contains|replace)\(([^)]*)\)/g)) {
    for (const s of m[1].matchAll(/["'`]([\w-]+)["'`]/g)) if (CLASS_RE.test(s[1])) classes.add(s[1]);
  }
  for (const m of text.matchAll(/["'`]([^"'`\n]*)["'`]/g)) {
    for (const s of m[1].matchAll(/(^|[\s>+~,(])([.#])(-?[A-Za-z_][\w-]*)/g)) {
      (s[2] === "." ? classes : ids).add(s[3]);
    }
  }
  return { classes: [...classes], ids: [...ids] };
}

const merge = (...all: PageNames[]): PageNames => ({
  classes: [...new Set(all.flatMap((n) => n.classes))].sort(),
  ids: [...new Set(all.flatMap((n) => n.ids))].sort(),
});

/** Names of the whole page, memoised per file text. */
export function pageNames(texts: FileTexts): () => PageNames {
  const h = one(htmlNames), c = one(cssNames), j = one(jsNames);
  return () => merge(h(texts("html")), c(texts("css")), j(texts("js")));
}

/** The rest of the name the caret is in (`.ca|rd` → "rd"): the name being typed is never its own suggestion. */
const wordAfter = (ctx: CompletionContext) => ctx.state.sliceDoc(ctx.pos, ctx.pos + 64).match(/^[\w-]*/)![0];

const nameOptions = (list: string[], prefix: "" | "." | "#", type: string, detail: string): Completion[] =>
  list.map((n) => ({ label: prefix + n, type, detail }));

// ---------- HTML ----------

const VOID = new Set((
  "area base br col embed hr img input link meta source track wbr"
).split(" "));
const BLOCK = new Set(["ul", "ol", "table", "tr", "thead", "tbody", "select", "dl", "nav", "form"]);

/** Tag → its snippet body (between the start and end tags); `${}` fields are where Tab goes next. */
const CHILDREN: Record<string, string> = {
  ul: "\n\t<li>${}</li>\n",
  ol: "\n\t<li>${}</li>\n",
  select: "\n\t<option>${}</option>\n",
  table: "\n\t<tr>\n\t\t<td>${}</td>\n\t</tr>\n",
  tr: "\n\t<td>${}</td>\n",
  dl: "\n\t<dt>${}</dt>\n\t<dd>${}</dd>\n",
};
const ATTRS: Record<string, string> = {
  a: ' href="${}"',
  img: ' src="${}" alt="${}"',
  input: ' type="${text}" name="${}"',
  label: ' for="${}"',
  button: ' type="button"',
  link: ' rel="stylesheet" href="${}"',
  form: ' action="${}"',
  iframe: ' src="${}"',
  meta: ' name="${}" content="${}"',
  source: ' src="${}"',
  textarea: ' name="${}"',
  select: ' name="${}"',
  option: ' value="${}"',
  video: ' src="${}" controls',
  audio: ' src="${}" controls',
};

export const HTML_TAGS = (
  "div span p a img button input label form textarea select option ul ol li dl dt dd h1 h2 h3 h4 " +
  "h5 h6 header footer main nav section article aside figure figcaption table thead tbody tr th td " +
  "strong em small code pre blockquote br hr canvas svg video audio source iframe details summary " +
  "dialog template progress meter output fieldset legend script style link meta time mark kbd abbr"
).split(" ");

/** The everyday tags first when several match (`d` → div before dd, dl, dt …). */
const BOOST: Record<string, number> = {
  div: 3,
  p: 2,
  span: 2,
  a: 2,
  button: 2,
  section: 1,
  ul: 1,
  li: 1,
  img: 1,
  input: 1,
  h1: 1,
  h2: 1,
};

/** `div.card#main.big` → tag, classes, id. Empty tag = div (when classes or an id are given). */
export function parseAbbreviation(s: string): { tag: string; classes: string[]; id: string } | null {
  const m = s.match(/^([a-z][a-z0-9-]*)?((?:[.#][A-Za-z_][\w-]*)*)$/i);
  if (!m || (!m[1] && !m[2])) return null;
  const classes: string[] = [];
  let id = "";
  for (const p of m[2].match(/[.#][\w-]+/g) ?? []) {
    if (p[0] === ".") classes.push(p.slice(1));
    else id = p.slice(1);
  }
  return { tag: (m[1] ?? "div").toLowerCase(), classes, id };
}

/** The snippet template for an abbreviation (CodeMirror snippet syntax: `${}` fields, `\t` = one indent). */
export function abbreviationSnippet(a: { tag: string; classes: string[]; id: string }): string {
  const attrs = (a.id ? ` id="${a.id}"` : "") + (a.classes.length ? ` class="${a.classes.join(" ")}"` : "") +
    (ATTRS[a.tag] ?? "");
  if (VOID.has(a.tag)) return `<${a.tag}${attrs}>`;
  const body = CHILDREN[a.tag] ?? (BLOCK.has(a.tag) ? "\n\t${}\n" : "${}");
  return `<${a.tag}${attrs}>${body}</${a.tag}>`;
}

function abbreviationOption(label: string, a: ReturnType<typeof parseAbbreviation> & object): Completion {
  const tpl = abbreviationSnippet(a);
  return snippetCompletion(tpl, {
    label,
    type: "type",
    detail: tpl.replace(/\$\{([^}]*)\}/g, "$1").replace(/\n\t?/g, " ").replace(/\s+/g, " ").slice(0, 60),
    boost: BOOST[a.tag] ?? 0,
  });
}

/** True when the HTML at `pos` is plain text between tags (not inside a tag, a comment or an attribute). */
function inHtmlText(tree: Tree, pos: number): boolean {
  const n = tree.resolveInner(pos, -1);
  return n.name === "Text" || n.name === "Document" || n.name === "Element";
}

export const htmlAbbreviationSource: CompletionSource = (ctx) => {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);
  const m = before.match(/(?:[a-z][a-z0-9-]*)?(?:[.#][\w-]*)*$/i);
  const word = m?.[0] ?? "";
  if (!word && !ctx.explicit) return null;
  const lead = before.slice(0, before.length - word.length);
  // only where a new element starts its own line (never after words or a tag on the line, where it would
  // turn ordinary text like "Summary" + Enter into a tag), with nothing but a tag or the end after the caret
  if (!/^\s*$/.test(lead)) return null;
  if (!/^\s*(<|$)/.test(line.text.slice(ctx.pos - line.from))) return null;
  if (!inHtmlText(syntaxTree(ctx.state), ctx.pos)) return null;
  const from = ctx.pos - word.length;
  if (/[.#]/.test(word)) {
    const a = parseAbbreviation(word.replace(/[.#]$/, ""));
    if (!a) return null;
    return { from, options: [abbreviationOption(word, a)], filter: false };
  }
  return {
    from,
    options: HTML_TAGS.map((t) => abbreviationOption(t, { tag: t, classes: [], id: "" })),
    validFor: /^[a-z][a-z0-9-]*$/i,
  };
};

/** Inside `class="…"` / `id="…"`: the classes / ids of the stylesheet (and the rest of the page). */
export function htmlAttrValueSource(names: () => PageNames): CompletionSource {
  return (ctx) => {
    const n = syntaxTree(ctx.state).resolveInner(ctx.pos, -1);
    if (n.name !== "AttributeValue" && n.name !== "UnquotedAttributeValue") return null;
    const nameNode = n.parent?.getChild("AttributeName");
    if (!nameNode) return null;
    const attr = ctx.state.sliceDoc(nameNode.from, nameNode.to).toLowerCase();
    if (attr !== "class" && attr !== "id") return null;
    const inner = ctx.state.sliceDoc(n.from, ctx.pos).replace(/^["']/, "");
    const word = inner.match(/[\w-]*$/)![0];
    if (attr === "id" && /\s/.test(inner)) return null;
    const pn = names();
    const list = attr === "class" ? pn.classes : pn.ids;
    const taken = new Set(inner.split(/\s+/).slice(0, -1));
    taken.add(word + wordAfter(ctx)); // the half-typed name itself
    return {
      from: ctx.pos - word.length,
      options: nameOptions(
        list.filter((c) => !taken.has(c)),
        "",
        "constant",
        attr === "class" ? "class" : "id",
      ),
      validFor: /^[\w-]*$/,
    };
  };
}

// ---------- CSS ----------

/** True inside a rule's declarations (`{ color: #fff }`); an `@media { … }` block is selector land. */
function inDeclarations(node: SyntaxNode | null): boolean {
  for (let n = node; n; n = n.parent) {
    if (n.name === "Block") return n.parent?.name === "RuleSet" || n.parent?.name === "KeyframesStatement";
  }
  return false;
}

/** `.` / `#` in a selector: the classes / ids of the HTML and the script. */
export function cssSelectorSource(names: () => PageNames): CompletionSource {
  return (ctx) => {
    const m = ctx.matchBefore(/[.#][\w-]*$/);
    if (!m) return null;
    const node = syntaxTree(ctx.state).resolveInner(ctx.pos, -1);
    if (inDeclarations(node)) {
      // `.x` right at the start of a declaration line inside a block is a nested selector
      const line = ctx.state.doc.lineAt(ctx.pos);
      if (!/^\s*$/.test(line.text.slice(0, m.from - line.from))) return null;
    }
    const pn = names();
    const cls = m.text[0] === ".";
    const typed = m.text.slice(1) + wordAfter(ctx);
    const list = (cls ? pn.classes : pn.ids).filter((n) => n !== typed);
    if (!list.length) return null;
    return {
      from: m.from,
      options: nameOptions(list, cls ? "." : "#", "constant", cls ? "class in the page" : "id in the page"),
      validFor: /^[.#][\w-]*$/,
    };
  };
}

// ---------- JavaScript ----------

const IDENT = /[A-Za-z_$][\w$]*/g;
const JS_SKIP = new Set(["LineComment", "BlockComment", "String", "TemplateString", "RegExp"]);

/** Words of the script itself (≥ 3 characters), so a name written once completes everywhere. */
export function scriptWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(IDENT)) if (m[0].length >= 3) out.add(m[0]);
  return out;
}

export const jsWordSource: CompletionSource = (() => {
  const words = one(scriptWords);
  return (ctx: CompletionContext): CompletionResult | null => {
    const w = ctx.matchBefore(/[A-Za-z_$][\w$]*$/);
    if (!w || (w.from === w.to && !ctx.explicit)) return null;
    const node = syntaxTree(ctx.state).resolveInner(ctx.pos, -1);
    if (JS_SKIP.has(node.name)) return null;
    // the word being typed is never offered as itself (Enter at the end of a line stays a new line)
    const typed = w.text + ctx.state.sliceDoc(ctx.pos, ctx.pos + 64).match(/^[\w$]*/)![0];
    const options: Completion[] = [];
    for (const label of words(ctx.state.doc.toString())) if (label !== typed) options.push({ label });
    return { from: w.from, options }; // no validFor: asked again per key, so the typed word stays out
  };
})();

const SELECTOR_CALL =
  /(?:getElementById|querySelector(?:All)?|closest|matches|classList\.(?:add|remove|toggle|contains|replace))\(\s*["'`][^"'`]*$/;

/** Inside the string argument of a DOM selector call: classes / ids of the page. */
export function jsSelectorStringSource(names: () => PageNames): CompletionSource {
  return (ctx) => {
    const node = syntaxTree(ctx.state).resolveInner(ctx.pos, -1);
    if (node.name !== "String" && node.name !== "TemplateString") return null;
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(0, ctx.pos - line.from);
    if (!SELECTOR_CALL.test(before)) return null;
    const m = before.match(/([.#]?)([\w-]*)$/)!;
    const typed = m[2] + wordAfter(ctx);
    const all = names();
    const pn = { classes: all.classes.filter((n) => n !== typed), ids: all.ids.filter((n) => n !== typed) };
    const byId = /getElementById\(\s*["'`][\w-]*$/.test(before);
    const classCall = /classList\.\w+\(\s*["'`][\w-]*$/.test(before);
    let options: Completion[];
    if (m[1] === ".") options = nameOptions(pn.classes, ".", "constant", "class in the page");
    else if (m[1] === "#") options = nameOptions(pn.ids, "#", "constant", "id in the page");
    else if (byId) options = nameOptions(pn.ids, "", "constant", "id in the page");
    else if (classCall) options = nameOptions(pn.classes, "", "constant", "class in the page");
    else {
      options = [
        ...nameOptions(pn.classes, ".", "constant", "class in the page"),
        ...nameOptions(pn.ids, "#", "constant", "id in the page"),
      ];
    }
    if (!options.length) return null;
    return { from: ctx.pos - m[0].length, options, validFor: /^[.#]?[\w-]*$/ };
  };
}

/**
 * Browser globals and their members, read from this window (same APIs as the preview). The app's own
 * test hook is left out. The range always starts at the identifier before the caret: the package's
 * `completionPath` can measure a longer node than what is typed (`X bar X`, caret after the first X →
 * from -1, a crash when the list is drawn).
 */
export const browserScopeSource: CompletionSource = (() => {
  const src = scopeCompletionSource(globalThis);
  return async (ctx: CompletionContext) => {
    const r = await src(ctx);
    if (!r) return r;
    const from = ctx.matchBefore(/[\w$\xaa-\uffdc]*$/)?.from ?? ctx.pos;
    return { ...r, from, options: r.options.filter((o) => !o.label.startsWith("__livecode")) };
  };
})();

/** The extra completion sources of a file (as language data: they run where that language is active). */
export function extraCompletions(file: FileId, texts: FileTexts): Extension {
  const names = pageNames(texts);
  if (file === "html") {
    return [
      htmlLanguage.data.of({ autocomplete: htmlAbbreviationSource }),
      htmlLanguage.data.of({ autocomplete: htmlAttrValueSource(names) }),
    ];
  }
  if (file === "css") return cssLanguage.data.of({ autocomplete: cssSelectorSource(names) });
  return [
    javascriptLanguage.data.of({ autocomplete: browserScopeSource }),
    javascriptLanguage.data.of({ autocomplete: jsWordSource }),
    javascriptLanguage.data.of({ autocomplete: jsSelectorStringSource(names) }),
  ];
}
