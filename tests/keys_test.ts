// Keys and keymap presets: notation, event matching, recording, and every preset conflict-free.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { canonical, displayBinding, eventStrokes, recordStroke } from "../src/client/keys.ts";
import { conflicts, effectiveBindings, isPlainKey, makeMatcher, PRESETS } from "../src/client/keymaps.ts";
import { ALL_COMMANDS, COMMAND_BY_ID } from "../src/client/commands.ts";

const ev = (key: string, code: string, mods: Partial<Record<"alt" | "ctrl" | "meta" | "shift", boolean>> = {}) => ({
  key,
  code,
  altKey: !!mods.alt,
  ctrlKey: !!mods.ctrl,
  metaKey: !!mods.meta,
  shiftKey: !!mods.shift,
});

Deno.test("keys: canonical form resolves Mod per platform and orders modifiers", () => {
  assertEquals(canonical("Mod-Shift-p", false), "Ctrl-Shift-p");
  assertEquals(canonical("Shift-Mod-P", true), "Meta-Shift-p");
  assertEquals(canonical("Mod-k Mod-0", false), "Ctrl-k Ctrl-0");
  assertEquals(canonical("Mod--", false), "Ctrl--");
  assertEquals(canonical("Mod-Shift--", false), "Ctrl-Shift--");
  assertEquals(canonical("Alt-Up", false), "Alt-ArrowUp");
  assertEquals(canonical("Ctrl-Space", false), "Ctrl-Space");
  assertEquals(canonical("esc", false), "Escape");
  assertThrows(() => canonical("Hyper-x", false));
});

Deno.test("keys: events match like CodeMirror (char first, then physical key)", () => {
  // Shift folded into "P" and the physical Shift-p are the same canonical key
  assertEquals(eventStrokes(ev("P", "KeyP", { ctrl: true, shift: true })), ["Ctrl-Shift-p"]);
  assertEquals(eventStrokes(ev("p", "KeyP", { ctrl: true })), ["Ctrl-p"]);
  assertEquals(canonical("Ctrl-P", false), "Ctrl-Shift-p");
  // macOS Alt-1 types "¡": the physical key still matches Alt-1
  assert(eventStrokes(ev("¡", "Digit1", { alt: true })).includes("Alt-1"));
  // AZERTY: Alt + the "&/1" key matches Alt-1 too
  assert(eventStrokes(ev("&", "Digit1", { alt: true })).includes("Alt-1"));
  assertEquals(eventStrokes(ev("F6", "F6")), ["F6"]);
  assertEquals(eventStrokes(ev("Shift", "ShiftLeft", { shift: true })), []);
  assert(eventStrokes(ev("?", "Slash", { ctrl: true, shift: true })).includes("Ctrl-Shift-/"));
  assert(eventStrokes(ev(" ", "Space", { ctrl: true })).includes("Ctrl-Space"));
});

Deno.test("keys: recorder stores the physical key with Mod", () => {
  assertEquals(recordStroke(ev("P", "KeyP", { ctrl: true, shift: true }), false), "Mod-Shift-p");
  assertEquals(recordStroke(ev("p", "KeyP", { meta: true }), true), "Mod-p");
  assertEquals(recordStroke(ev("¡", "Digit1", { alt: true }), true), "Alt-1");
  assertEquals(recordStroke(ev("F2", "F2"), false), "F2");
  assertEquals(recordStroke(ev("Control", "ControlLeft", { ctrl: true }), false), null);
  assertEquals(recordStroke(ev("?", "Slash", { shift: true }), false), "Shift-/");
  // what is recorded is matched again by the same keys
  const e = ev("K", "KeyK", { ctrl: true, shift: true });
  assert(eventStrokes(e).includes(canonical(recordStroke(e, false)!, false)));
});

Deno.test("keys: display", () => {
  assertEquals(displayBinding("Mod-Shift-p", false), "Ctrl+Shift+P");
  assertEquals(displayBinding("Mod-Shift-p", true), "⇧⌘P");
  assertEquals(displayBinding("Mod-k Mod-s", false), "Ctrl+K Ctrl+S");
  assertEquals(displayBinding("Alt-ArrowUp", false), "Alt+↑");
});

Deno.test("presets: every command known, every binding parses, no conflict (Linux/Windows and macOS)", () => {
  assertEquals(new Set(ALL_COMMANDS.map((c) => c.id)).size, ALL_COMMANDS.length, "duplicate command id");
  for (const p of PRESETS) {
    for (const id of Object.keys(p.bindings)) assert(COMMAND_BY_ID.has(id), `${p.id}: unknown command ${id}`);
    for (const c of ALL_COMMANDS) assert(c.id in p.bindings, `${p.id}: no entry for ${c.id}`);
    for (const mac of [false, true]) {
      for (const keys of Object.values(p.bindings)) for (const k of keys) canonical(k, mac);
      const clash = conflicts(p.bindings, mac);
      assertEquals([...clash], [], `${p.id} (${mac ? "mac" : "pc"}) conflicts`);
    }
    assert((p.bindings.run ?? []).length > 0, `${p.id}: no key runs the preview`);
    assert((p.bindings.palette ?? []).length > 0, `${p.id}: no key opens the palette`);
  }
});

Deno.test("presets: Emacs and Vim keep their own prefixes", () => {
  const emacs = PRESETS.find((p) => p.id === "emacs")!;
  for (const keys of Object.values(emacs.bindings)) {
    for (const k of keys) {
      const first = canonical(k, false).split(" ")[0];
      assert(!["Ctrl-x", "Ctrl-c", "Ctrl-h"].includes(first), `emacs preset steals ${first}`);
    }
  }
  const vim = PRESETS.find((p) => p.id === "vim")!;
  for (const keys of Object.values(vim.bindings)) {
    for (const k of keys) assert(!isPlainKey(canonical(k, false)) || /^F\d/.test(k), `vim preset binds plain ${k}`);
  }
});

Deno.test("overrides: replace one command's keys, empty list unbinds, matcher handles chords", () => {
  const b = effectiveBindings("vscode", { run: ["F5"], find: [] });
  assertEquals(b.run, ["F5"]);
  assertEquals(b.find, []);
  assertEquals(b.undo, ["Mod-z"]);
  const m = makeMatcher(b, false);
  assertEquals(m.get("F5"), "run");
  assertEquals(m.get("Ctrl-s"), undefined);
  assertEquals(m.get("Ctrl-f"), undefined);
  assert(m.isPrefix("Ctrl-k"));
  assertEquals(m.get("Ctrl-k Ctrl-s"), "keybindings");
  // a user conflict is reported
  const c = conflicts(effectiveBindings("vscode", { run: ["Mod-f"] }), false);
  assertEquals(c.get("Ctrl-f")?.sort(), ["find", "run"]);
  // a single key that is also a chord prefix is a conflict
  const p = conflicts(effectiveBindings("vscode", { help: ["Mod-k"] }), false);
  assert(p.has("Ctrl-k"));
});

Deno.test("plain keys are not run inside text fields", () => {
  assert(isPlainKey("a"));
  assert(isPlainKey("Shift-a"));
  assert(isPlainKey("Enter"));
  assert(!isPlainKey("Ctrl-a"));
  assert(!isPlainKey("Alt-1"));
  assert(!isPlainKey("F6"));
  assert(!isPlainKey("Escape"));
});
