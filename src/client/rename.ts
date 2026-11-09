// Rename (owner, 2026-11-09: "renaming … in the editor too"): VS Code F2, JetBrains Shift+F6, the palette.
// A small box at the name, every use of it highlighted while the new name is typed; Enter renames them all in
// one edit (one undo step, shared with the room), Escape or leaving the box cancels.
// - The script (JavaScript or TypeScript): the TypeScript service finds the uses — scope-aware, so another
//   `x` in another function is not touched, a property renames where that property is used.
// - HTML / CSS: every occurrence of the word in the file (a class or an id, a tag name, a custom property …).
// Pure parts (occurrences, name checks) are tested in tests/rename_test.ts.

import { type EditorState, type Extension, Facet, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, showTooltip, type Tooltip } from "@codemirror/view";
import type { FileId } from "../shared/protocol.ts";
import { tsClient } from "./ts/client.ts";

export interface Range {
  from: number;
  to: number;
}

/** Which file an editor holds, and the script's language: rename picks its way from it. */
export const renameFile = Facet.define<
  { file: FileId; lang: "js" | "ts" },
  { file: FileId; lang: "js" | "ts" } | null
>({
  combine: (v) => v[0] ?? null,
});

/** Characters of a name in each file (CSS / HTML names have dashes). */
const NAME_CHAR: Record<FileId, RegExp> = { html: /[\w-]/, css: /[\w-]/, js: /[\w$]/ };

/** The word around `pos` (the caret inside or right after it), or null. */
export function wordAt(text: string, pos: number, char: RegExp): (Range & { word: string }) | null {
  let from = pos, to = pos;
  while (from > 0 && char.test(text[from - 1])) from--;
  while (to < text.length && char.test(text[to])) to++;
  if (from === to) return null;
  const word = text.slice(from, to);
  if (/^[\d-]+$/.test(word)) return null; // a number or dashes: nothing to rename
  return { from, to, word };
}

/** Every whole-word occurrence of `word` (not inside a longer name). */
export function occurrences(text: string, word: string, char: RegExp): Range[] {
  const out: Range[] = [];
  if (!word) return out;
  for (let i = text.indexOf(word); i >= 0; i = text.indexOf(word, i + word.length)) {
    const before = i > 0 ? text[i - 1] : "";
    const after = text[i + word.length] ?? "";
    if ((before && char.test(before)) || (after && char.test(after))) continue;
    out.push({ from: i, to: i + word.length });
  }
  return out;
}

const RESERVED = new Set((
  "break case catch class const continue debugger default delete do else enum export extends false finally for " +
  "function if import in instanceof new null return super switch this throw true try typeof var void while with " +
  "yield let static implements interface package private protected public await"
).split(" "));

/** Why `name` can't replace `old` (null = fine). Script names are identifiers; HTML / CSS names have dashes. */
export function nameProblem(name: string, old: string, script: boolean): string | null {
  if (!name) return "Type a name";
  if (name === old) return "That is the current name";
  if (script) {
    const priv = old.startsWith("#");
    const bare = priv ? name.replace(/^#/, "") : name;
    if (priv !== name.startsWith("#") && priv) return "A private name starts with #";
    if (!/^[A-Za-z_$ -￿][\w$ -￿]*$/.test(bare)) return "Not a valid name (letters, digits, _ or $)";
    if (RESERVED.has(bare)) return `"${bare}" is a reserved word`;
    return null;
  }
  return /^[A-Za-z_ -￿-][\w -￿-]*$/.test(name) ? null : "Not a valid name (letters, digits, - or _)";
}

// ---------- the box ----------

interface Open {
  kind: "rename";
  name: string;
  ranges: Range[];
  script: boolean;
  tip: Tooltip;
}
interface Message {
  kind: "message";
  tip: Tooltip;
}
type RenameState = Open | Message | null;

const setRename = StateEffect.define<RenameState>();
const mark = Decoration.mark({ class: "cm-lc-renameTarget" });

const renameField = StateField.define<RenameState>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setRename)) return e.value;
    if (!v) return v;
    if (v.kind === "message") return tr.docChanged || tr.selection ? null : v;
    if (!tr.docChanged) return v;
    // someone else edited meanwhile: the uses follow; one of them gone → the rename is off
    const ranges = v.ranges.map((r) => ({
      from: tr.changes.mapPos(r.from, 1),
      to: tr.changes.mapPos(r.to, -1),
    }));
    if (ranges.some((r) => r.to - r.from !== v.name.length)) return null;
    return { ...v, ranges };
  },
  provide: (f) => [
    showTooltip.from(f, (v) => v?.tip ?? null),
    EditorView.decorations.from(
      f,
      (v) =>
        v?.kind === "rename"
          ? Decoration.set(v.ranges.map((r) => mark.range(r.from, r.to)), true)
          : Decoration.none,
    ),
  ],
});

function close(view: EditorView, refocus: boolean) {
  if (!view.state.field(renameField, false)) return;
  view.dispatch({ effects: setRename.of(null) });
  if (refocus) view.focus();
}

function messageTip(pos: number, text: string): Message {
  return {
    kind: "message",
    tip: {
      pos,
      above: true,
      create: () => {
        const dom = document.createElement("div");
        dom.className = "cm-lc-renameMsg";
        dom.textContent = text;
        return { dom };
      },
    },
  };
}

function renameTip(
  at: number,
  name: string,
  ranges: Range[],
  script: boolean,
  say: (m: string) => void,
): Open {
  const tip: Tooltip = {
    pos: at,
    above: true, // over the name: the next lines' uses stay visible (below when there is no room above)
    create: (view) => {
      const dom = document.createElement("form");
      dom.className = "cm-lc-rename";
      dom.setAttribute("aria-label", `Rename ${name}`);
      const input = document.createElement("input");
      input.value = name;
      input.spellcheck = false;
      input.setAttribute(
        "aria-label",
        `New name for ${name}, ${ranges.length} ${ranges.length === 1 ? "place" : "places"}`,
      );
      const info = document.createElement("span");
      info.className = "cm-lc-renameInfo";
      const where = `${ranges.length} ${ranges.length === 1 ? "place" : "places"}`;
      info.textContent = `${where} · Enter to rename · Esc`;
      dom.append(input, info);
      const problem = () => nameProblem(input.value.trim(), name, script);
      input.addEventListener("input", () => {
        const p = input.value.trim() === name ? null : problem();
        info.textContent = p ?? `${where} · Enter to rename · Esc`;
        input.setAttribute("aria-invalid", String(!!p));
      });
      dom.addEventListener("submit", (e) => {
        e.preventDefault();
        const next = input.value.trim();
        const p = problem();
        if (p) {
          info.textContent = p;
          say(p);
          return;
        }
        const st = view.state.field(renameField, false);
        if (!st || st.kind !== "rename") return close(view, true);
        view.dispatch({
          changes: st.ranges.map((r) => ({ from: r.from, to: r.to, insert: next })),
          effects: setRename.of(null),
          userEvent: "rename",
        });
        view.focus();
        say(
          `Renamed ${name} to ${next} in ${st.ranges.length} ${st.ranges.length === 1 ? "place" : "places"}`,
        );
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          close(view, true);
        }
      });
      dom.addEventListener("focusout", (e) => {
        if (!dom.contains(e.relatedTarget as Node | null)) setTimeout(() => close(view, false), 0);
      });
      return {
        dom,
        mount: () => {
          input.focus();
          input.select();
        },
      };
    },
  };
  return { kind: "rename", name, ranges, script, tip };
}

/** The rename command: the box at the name under the caret (or a short message why not). */
export function renameSymbol(view: EditorView, say: (m: string) => void = () => {}): boolean {
  const where = view.state.facet(renameFile);
  if (!where || view.state.readOnly) return false;
  const doc = view.state.doc;
  const pos = view.state.selection.main.head;
  const text = doc.toString();
  const show = (s: RenameState) => {
    view.dispatch({ effects: setRename.of(s) });
    if (s?.kind === "message") {
      setTimeout(() => view.state.field(renameField, false) === s && close(view, false), 4000);
    }
  };
  if (where.file === "js") {
    tsClient().call("rename", text, pos, where.lang).then((r) => {
      if (view.state.doc !== doc) return; // edited meanwhile: press again
      if (!r.ok) {
        say(r.message);
        return show(messageTip(pos, r.message));
      }
      show(renameTip(r.from, r.name, r.ranges, true, say));
    }, () => {
      say("Rename is not available (TypeScript could not load)");
      show(messageTip(pos, "Rename is not available (TypeScript could not load)"));
    });
    return true;
  }
  const w = wordAt(text, pos, NAME_CHAR[where.file]);
  if (!w) {
    say("No name at the cursor");
    show(messageTip(pos, "No name at the cursor"));
    return true;
  }
  show(renameTip(w.from, w.word, occurrences(text, w.word, NAME_CHAR[where.file]), false, say));
  return true;
}

/** True while the rename box (or its message) is open. */
export const renaming = (s: EditorState): boolean => !!s.field(renameField, false);

/** The editor side: the box, the highlighted uses, and this editor's file. */
export function renameExtension(file: FileId, lang: "js" | "ts"): Extension {
  return [renameFile.of({ file, lang }), renameField];
}
