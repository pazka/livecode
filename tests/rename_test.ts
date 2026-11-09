// Rename (names, occurrences, checks) and the mouse gestures of multiple cursors.

import { assert, assertEquals } from "@std/assert";
import { nameProblem, occurrences, wordAt } from "../src/client/rename.ts";
import { displayMouse, mouseMods } from "../src/client/keys.ts";
import { PRESETS } from "../src/client/keymaps.ts";

const JS = /[\w$]/, CSS = /[\w-]/;

Deno.test("rename: the word at the caret (inside, at its end), dashes in CSS / HTML names", () => {
  assertEquals(wordAt("let total = 1;", 6, JS), { from: 4, to: 9, word: "total" });
  assertEquals(wordAt("let total = 1;", 9, JS)?.word, "total"); // right after it
  assertEquals(wordAt(".card-title { }", 3, CSS)?.word, "card-title");
  assertEquals(wordAt("a = 1;", 5, JS), null); // on ";"
  assertEquals(wordAt("x = 42;", 5, JS), null); // a number
});

Deno.test("rename: whole-word occurrences only", () => {
  const css = ".card { }\n.card-title { }\n.big.card:hover { }\n#card { }";
  // .card (yes), .card-title (no: longer name), .big.card:hover (yes), #card (yes)
  const at = occurrences(css, "card", CSS).map((r) => css.slice(r.from - 1, r.to + 1));
  assertEquals(at, [".card ", ".card:", "#card "]);
  assertEquals(occurrences("ab abc cab ab", "ab", JS).length, 2);
  assertEquals(occurrences("x", "", JS), []);
});

Deno.test("rename: new names are checked (identifiers in the script, dashes allowed in HTML / CSS)", () => {
  assertEquals(nameProblem("count", "total", true), null);
  assertEquals(nameProblem("$el_2", "el", true), null);
  assert(nameProblem("2fast", "a", true));
  assert(nameProblem("my-name", "a", true));
  assert(nameProblem("class", "a", true)?.includes("reserved"));
  assert(nameProblem("total", "total", true)); // unchanged
  assertEquals(nameProblem("#next", "#prev", true), null);
  assert(nameProblem("next", "#prev", true));
  assertEquals(nameProblem("card-title", "card", false), null);
  assert(nameProblem("card title", "card", false));
  assert(nameProblem("", "card", false));
});

Deno.test("mouse: modifiers match exactly (Mod = Cmd on macOS, Ctrl elsewhere)", () => {
  const ev = (m: Partial<Record<"alt" | "shift" | "ctrl" | "meta", boolean>>) => ({
    altKey: !!m.alt,
    shiftKey: !!m.shift,
    ctrlKey: !!m.ctrl,
    metaKey: !!m.meta,
  });
  assert(mouseMods(ev({ alt: true }), "Alt", false));
  assert(!mouseMods(ev({ alt: true, shift: true }), "Alt", false));
  assert(mouseMods(ev({ alt: true, shift: true }), "Alt-Shift", false));
  assert(mouseMods(ev({ ctrl: true }), "Mod", false));
  assert(!mouseMods(ev({ ctrl: true }), "Mod", true));
  assert(mouseMods(ev({ meta: true }), "Mod", true));
  assert(!mouseMods(ev({}), "Alt", false));
  assertEquals(displayMouse("Alt-Shift", "Drag", false), "Alt+Shift+Drag");
  assertEquals(displayMouse("Alt", "Click", true), "⌥Click");
  assertEquals(displayMouse("Mod", "Click", false), "Ctrl+Click");
});

Deno.test("mouse: every preset's add-cursor and column gestures differ (a click never means both)", () => {
  for (const p of PRESETS) assert(p.mouse.addCursor !== p.mouse.column, p.id);
  const vscode = PRESETS.find((p) => p.id === "vscode")!;
  assertEquals(vscode.mouse, { addCursor: "Alt", column: "Alt-Shift" });
  const jb = PRESETS.find((p) => p.id === "jetbrains")!;
  assertEquals(jb.mouse, { addCursor: "Alt-Shift", column: "Alt" });
});
