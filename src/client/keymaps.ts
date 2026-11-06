// Keymap presets (VS Code, JetBrains, Sublime Text, Vim, Emacs) + the user's own overrides per preset.
// One matcher (main.ts, document keydown in the capture phase, chords included) runs every binding below,
// editor and app commands alike; CodeMirror itself only keeps the plain editing keys (fallbackKeymap) and,
// for the modal presets, the vim / emacs extension, which sees keys first inside the editor.

import { closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands";
import { foldKeymap } from "@codemirror/language";
import { searchKeymap } from "@codemirror/search";
import type { KeyBinding } from "@codemirror/view";
import { COMMAND_BY_ID, MANAGED_RUNS } from "./commands.ts";
import { canonical, IS_MAC } from "./keys.ts";

export type PresetId = "vscode" | "jetbrains" | "sublime" | "vim" | "emacs";
export type Bindings = Record<string, string[]>;

export interface Preset {
  id: PresetId;
  label: string;
  /** Modal extension that owns most keys inside the editor. */
  ext: "vim" | "emacs" | null;
  bindings: Bindings;
}

// App commands that read the same in most presets.
const COMMON_APP: Bindings = {
  run: ["Mod-Enter", "Mod-s"],
  toggleAutoRun: ["Mod-Shift-Enter"],
  toggleConsole: ["Mod-`"],
  clearConsole: [],
  toggleKeepConsole: [],
  focusPreview: [],
  tabHtml: ["Alt-1"],
  tabCss: ["Alt-2"],
  tabJs: ["Alt-3"],
  toggleTypeScript: [],
  nextTab: ["Alt-]"],
  prevTab: ["Alt-["],
  focusEditor: [],
  paneOnly: [],
  paneSplit: [],
  paneAll: [],
  paneClose: [],
  paneMoveBack: [],
  paneMoveForward: [],
  paneDirection: [],
  nextPane: ["F6"],
  palette: ["Mod-Shift-p", "F1"],
  settings: ["Mod-,"],
  keybindings: [],
  cycleTheme: [],
  toggleLayout: [],
  toggleWrap: [],
  fontBigger: [],
  fontSmaller: [],
  fontReset: [],
  copyLink: [],
  newRoom: [],
  help: [],
};

const NO_EDITOR: Bindings = {
  undo: [],
  redo: [],
  toggleComment: [],
  toggleBlockComment: [],
  moveLineUp: [],
  moveLineDown: [],
  copyLineUp: [],
  copyLineDown: [],
  deleteLine: [],
  insertBlankLine: [],
  indentMore: [],
  indentLess: [],
  reindent: [],
  startCompletion: [],
  showType: [],
  selectAll: [],
  selectLine: [],
  selectNextOccurrence: [],
  selectAllOccurrences: [],
  addCursorAbove: [],
  addCursorBelow: [],
  expandSelection: [],
  singleSelection: [],
  matchingBracket: [],
  find: [],
  replace: [],
  findNext: [],
  findPrevious: [],
  gotoLine: [],
  fold: [],
  unfold: [],
  foldAll: [],
  unfoldAll: [],
  toggleTabFocus: [],
};

export const PRESETS: Preset[] = [
  {
    id: "vscode",
    label: "VS Code",
    ext: null,
    bindings: {
      ...NO_EDITOR,
      ...COMMON_APP,
      undo: ["Mod-z"],
      redo: ["Mod-y", "Mod-Shift-z"],
      toggleComment: ["Mod-/"],
      toggleBlockComment: ["Shift-Alt-a"],
      moveLineUp: ["Alt-ArrowUp"],
      moveLineDown: ["Alt-ArrowDown"],
      copyLineUp: ["Shift-Alt-ArrowUp"],
      copyLineDown: ["Shift-Alt-ArrowDown"],
      deleteLine: ["Mod-Shift-k"],
      indentMore: ["Mod-]"],
      indentLess: ["Mod-["],
      reindent: ["Shift-Alt-f"],
      startCompletion: ["Ctrl-Space"],
      showType: ["Mod-k Mod-i"],
      selectAll: ["Mod-a"],
      selectLine: ["Mod-l"],
      selectNextOccurrence: ["Mod-d"],
      selectAllOccurrences: ["Mod-Shift-l"],
      addCursorAbove: ["Mod-Alt-ArrowUp"],
      addCursorBelow: ["Mod-Alt-ArrowDown"],
      expandSelection: ["Shift-Alt-ArrowRight"],
      singleSelection: ["Escape"],
      matchingBracket: ["Mod-Shift-\\"],
      find: ["Mod-f"],
      replace: ["Mod-h"],
      findNext: ["F3"],
      findPrevious: ["Shift-F3"],
      gotoLine: ["Mod-g"],
      fold: ["Mod-Shift-["],
      unfold: ["Mod-Shift-]"],
      foldAll: ["Mod-k Mod-0"],
      unfoldAll: ["Mod-k Mod-j"],
      toggleTabFocus: ["Ctrl-m"],
      toggleConsole: ["Mod-`", "Mod-j"],
      keybindings: ["Mod-k Mod-s"],
      cycleTheme: ["Mod-k Mod-t"],
      toggleWrap: ["Alt-z"],
      help: ["Mod-k Mod-h"],
      paneSplit: ["Mod-\\"],
    },
  },
  {
    id: "jetbrains",
    label: "JetBrains (IntelliJ, WebStorm…)",
    ext: null,
    bindings: {
      ...NO_EDITOR,
      ...COMMON_APP,
      undo: ["Mod-z"],
      redo: ["Mod-Shift-z"],
      toggleComment: ["Mod-/"],
      toggleBlockComment: ["Mod-Shift-/"],
      moveLineUp: ["Alt-Shift-ArrowUp"],
      moveLineDown: ["Alt-Shift-ArrowDown"],
      copyLineDown: ["Mod-d"],
      deleteLine: ["Mod-y"],
      insertBlankLine: ["Shift-Enter"],
      reindent: ["Mod-Alt-l"],
      startCompletion: ["Ctrl-Space"],
      selectAll: ["Mod-a"],
      selectNextOccurrence: ["Alt-j"],
      selectAllOccurrences: ["Mod-Alt-Shift-j"],
      // Ctrl-W (extend selection) closes the browser tab and can't be caught: the macOS key instead
      expandSelection: ["Alt-ArrowUp"],
      singleSelection: ["Escape"],
      matchingBracket: ["Mod-Shift-m"],
      find: ["Mod-f"],
      replace: ["Mod-r"],
      findNext: ["F3"],
      findPrevious: ["Shift-F3"],
      gotoLine: ["Mod-g"],
      fold: ["Mod--"],
      unfold: ["Mod-="],
      foldAll: ["Mod-Shift--"],
      unfoldAll: ["Mod-Shift-="],
      toggleTabFocus: ["Shift-Alt-m"],
      run: ["Shift-F10", "Mod-Enter", "Mod-s"],
      toggleAutoRun: [],
      toggleConsole: ["Alt-4"],
      // Alt+←/→ is word-jump on macOS: JetBrains for Mac switches tabs with ⌘⇧] / ⌘⇧[
      nextTab: IS_MAC ? ["Mod-Shift-]"] : ["Alt-ArrowRight"],
      prevTab: IS_MAC ? ["Mod-Shift-["] : ["Alt-ArrowLeft"],
      palette: ["Mod-Shift-a", "F1"],
      settings: ["Mod-Alt-s"],
      cycleTheme: ["Ctrl-`"],
    },
  },
  {
    id: "sublime",
    label: "Sublime Text",
    ext: null,
    bindings: {
      ...NO_EDITOR,
      ...COMMON_APP,
      undo: ["Mod-z"],
      redo: ["Mod-Shift-z", "Mod-y"],
      toggleComment: ["Mod-/"],
      toggleBlockComment: ["Mod-Shift-/"],
      moveLineUp: ["Mod-Shift-ArrowUp"],
      moveLineDown: ["Mod-Shift-ArrowDown"],
      copyLineDown: ["Mod-Shift-d"],
      deleteLine: ["Mod-Shift-k"],
      insertBlankLine: ["Mod-Enter"],
      indentMore: ["Mod-]"],
      indentLess: ["Mod-["],
      startCompletion: ["Ctrl-Space"],
      selectAll: ["Mod-a"],
      selectLine: ["Mod-l"],
      selectNextOccurrence: ["Mod-d"],
      selectAllOccurrences: ["Alt-F3"],
      addCursorAbove: ["Mod-Alt-ArrowUp"],
      addCursorBelow: ["Mod-Alt-ArrowDown"],
      expandSelection: ["Mod-Shift-Space"],
      singleSelection: ["Escape"],
      matchingBracket: ["Mod-m"],
      find: ["Mod-f"],
      replace: ["Mod-h"],
      findNext: ["F3"],
      findPrevious: ["Shift-F3"],
      gotoLine: ["Mod-g"],
      fold: ["Mod-Shift-["],
      unfold: ["Mod-Shift-]"],
      foldAll: ["Mod-k Mod-1"],
      unfoldAll: ["Mod-k Mod-j"],
      toggleTabFocus: ["Shift-Alt-m"],
      run: ["Mod-b", "Mod-s"],
    },
  },
  {
    id: "vim",
    label: "Vim",
    ext: "vim",
    bindings: {
      ...NO_EDITOR,
      ...COMMON_APP,
      toggleComment: ["Mod-/"],
      startCompletion: ["Ctrl-Space"],
      toggleTabFocus: ["Shift-Alt-m"],
    },
  },
  {
    id: "emacs",
    label: "Emacs",
    ext: "emacs",
    bindings: {
      ...NO_EDITOR,
      ...COMMON_APP,
      // no Ctrl-x / Ctrl-c / Ctrl-h chords here: they would swallow the Emacs prefixes
      toggleComment: ["Alt-;"],
      startCompletion: ["Alt-/"],
      gotoLine: ["Alt-g Alt-g"],
      toggleTabFocus: ["Shift-Alt-m"],
      run: ["Mod-Enter"],
      toggleAutoRun: [],
      toggleConsole: [],
      palette: ["Alt-x", "F1"],
    },
  },
];

export const PRESET_BY_ID: ReadonlyMap<PresetId, Preset> = new Map(PRESETS.map((p) => [p.id, p]));

export function isPresetId(s: unknown): s is PresetId {
  return typeof s === "string" && PRESET_BY_ID.has(s as PresetId);
}

/** Preset bindings with the user's overrides on top (an override replaces that command's keys). */
export function effectiveBindings(preset: PresetId, overrides: Bindings = {}): Bindings {
  const base = PRESET_BY_ID.get(preset)?.bindings ?? PRESETS[0].bindings;
  const out: Bindings = {};
  for (const id of COMMAND_BY_ID.keys()) out[id] = [...(overrides[id] ?? base[id] ?? [])];
  return out;
}

/** Keys bound to more than one command: canonical key → command ids. */
export function conflicts(b: Bindings, mac = IS_MAC): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  for (const [id, keys] of Object.entries(b)) {
    for (const k of keys) {
      let c: string;
      try {
        c = canonical(k, mac);
      } catch {
        continue;
      }
      seen.set(c, [...(seen.get(c) ?? []), id]);
    }
  }
  // a chord whose first stroke is also a whole binding can never fire: count it as a conflict too
  for (const c of [...seen.keys()]) {
    const first = c.split(" ")[0];
    if (c.includes(" ") && seen.has(first)) {
      seen.set(first, [...new Set([...seen.get(first)!, ...seen.get(c)!])]);
    }
  }
  return new Map([...seen].filter(([, ids]) => new Set(ids).size > 1));
}

export interface Matcher {
  /** Command for a full binding (canonical, chords space-joined). */
  get(binding: string): string | undefined;
  /** True when `stroke` starts a chord. */
  isPrefix(stroke: string): boolean;
}

/** Canonical lookup table; the first command listed wins a conflict. */
export function makeMatcher(b: Bindings, mac = IS_MAC): Matcher {
  const map = new Map<string, string>();
  const prefixes = new Set<string>();
  for (const [id, keys] of Object.entries(b)) {
    for (const k of keys) {
      let c: string;
      try {
        c = canonical(k, mac);
      } catch {
        continue;
      }
      if (!map.has(c)) map.set(c, id);
      const strokes = c.split(" ");
      for (let i = 1; i < strokes.length; i++) prefixes.add(strokes.slice(0, i).join(" "));
    }
  }
  return { get: (k) => map.get(k), isPrefix: (s) => prefixes.has(s) };
}

/** True for a binding that would type a character in a text field (no Ctrl / Alt / Meta, not an F-key). */
export function isPlainKey(stroke: string): boolean {
  return !/(^|-)(Ctrl|Alt|Meta)-/.test(stroke) && !/^(Shift-)?(F\d{1,2}|Escape)$/.test(stroke);
}

const unmanaged = (km: readonly KeyBinding[]) =>
  km.filter((b) => !(b.run && MANAGED_RUNS.has(b.run)) && !(b.shift && MANAGED_RUNS.has(b.shift)));

/** Plain editing keys every preset keeps inside CodeMirror (arrows, Enter, Backspace, Tab …). */
export function fallbackKeymap(): KeyBinding[] {
  return [
    ...closeBracketsKeymap,
    ...unmanaged(completionKeymap),
    ...unmanaged(searchKeymap),
    ...unmanaged(historyKeymap),
    ...unmanaged(foldKeymap),
    ...unmanaged(defaultKeymap),
    indentWithTab,
  ];
}
