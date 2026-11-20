// Go to the code (gotodef.ts): the page's names across the three files. The script's own names come from the
// TypeScript service (tests/typescript_test.ts).

import { assertEquals } from "@std/assert";
import { htmlLanguage } from "@codemirror/lang-html";
import { cssLanguage } from "@codemirror/lang-css";
import { javascriptLanguage } from "@codemirror/lang-javascript";
import type { FileId } from "../src/shared/protocol.ts";
import { findName, nameAt, type PageName } from "../src/client/gotodef.ts";

const HTML = `<main class="page wide">
  <h1 id="title" class="big">Hi</h1>
  <label for="name">Name</label><input id="name" aria-describedby="hint">
  <a href="#title">top</a><p id="hint" class="note">…</p>
</main>`;
const CSS = `:root { --gap: 4px; --ink: #fff; }
.page { padding: var(--gap); color: var(--ink) }
#title, .big { margin: 0 }
.note:hover { color: #add }`;
const JS = `const t = document.getElementById("title");
document.querySelector("main .page > #name").focus();
t.classList.add("big", "shown");
const plain = "page";`;
const texts = (f: FileId) => ({ html: HTML, css: CSS, js: JS })[f];
const PARSERS = { html: htmlLanguage.parser, css: cssLanguage.parser, js: javascriptLanguage.parser };

/** The name at the first occurrence of `needle` in a file (the cursor `offset` characters into it). */
function at(file: FileId, needle: string, offset = 1): PageName | null {
  const text = texts(file);
  const i = text.indexOf(needle);
  if (i < 0) throw new Error(`no ${needle} in ${file}`);
  return nameAt(file, PARSERS[file].parse(text), text, i + offset);
}
/** Where it leads: "file: the text there". */
function leads(file: FileId, needle: string, offset = 1): string | null {
  const n = at(file, needle, offset);
  const t = n && findName(n, file, texts);
  if (!t) return null;
  const text = texts(t.file);
  const line = text.slice(text.lastIndexOf("\n", t.from) + 1).split("\n")[0];
  return `${t.file}: ${text.slice(t.from, t.to)} in ${line.trim().slice(0, 30)}`;
}

Deno.test("go to: the names of the page are recognised where they are used", () => {
  assertEquals(at("html", "wide")?.kind, "class");
  assertEquals(at("html", "page wide", 2), { kind: "class", name: "page", from: 13, to: 17 });
  assertEquals(at("html", 'title" class')?.kind, "id");
  assertEquals(at("html", 'name">Name')?.kind, "id"); // for="name"
  assertEquals(at("html", "#title", 2)?.kind, "id"); // href="#title"
  assertEquals(at("html", "hint", 1)?.name, "hint"); // aria-describedby
  assertEquals(at("html", "Hi"), null); // text of the page
  assertEquals(at("html", "main"), null); // a tag name
  assertEquals(at("css", ".page", 2), { kind: "class", name: "page", from: 36, to: 40 });
  assertEquals(at("css", "#title", 2)?.name, "title");
  assertEquals(at("css", "var(--gap)", 6)?.kind, "var");
  assertEquals(at("css", "--gap: 4px", 2), null); // where it is set: not a link
  assertEquals(at("css", "#add", 2), null); // a colour, not an id
  assertEquals(at("css", "padding"), null);
  assertEquals(at("js", '"title"', 2)?.kind, "id"); // getElementById("title")
  assertEquals(at("js", ".page", 2)?.kind, "class");
  assertEquals(at("js", "#name", 2)?.kind, "id");
  assertEquals(at("js", '"shown"', 2)?.kind, "class"); // classList.add(…, "shown")
  assertEquals(at("js", '"page"', 2), null); // a plain string
  assertEquals(at("js", "document"), null); // code: the TypeScript service's
});

Deno.test("go to: script and stylesheet lead to the element; the HTML leads to the rule, else the script", () => {
  assertEquals(leads("js", '"title"', 2), 'html: title in <h1 id="title" class="big">Hi<');
  assertEquals(leads("js", ".page", 2), 'html: page in <main class="page wide">');
  assertEquals(
    leads("js", "#name", 2),
    'html: name in <label for="name">Name</label>'.replace("label for", "label for"),
  );
  assertEquals(leads("css", ".note", 2), 'html: note in <a href="#title">top</a><p id=');
  assertEquals(leads("css", "#title", 2), 'html: title in <h1 id="title" class="big">Hi<');
  assertEquals(leads("css", "var(--ink)", 6), "css: --ink in :root { --gap: 4px; --ink: #ff");
  assertEquals(leads("html", "wide"), null); // no rule, no script names it
  assertEquals(leads("html", "page wide", 2), "css: page in .page { padding: var(--gap); c");
  assertEquals(leads("html", "big"), "css: big in #title, .big { margin: 0 }");
  assertEquals(leads("html", 'name" aria'), 'js: name in document.querySelector("main .');
  // a name only the script knows ("shown"): nowhere to go from the script
  assertEquals(leads("js", '"shown"', 2), null);
});
