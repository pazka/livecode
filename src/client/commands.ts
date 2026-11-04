// Every bindable action, editor and app alike. Keymap presets (keymaps.ts) map these ids to keys; the
// shortcut editor and the command palette list them. Editor commands run on the focused editor; app
// commands get their handler at start-up (main.ts → setAppHandler).

import {
  addCursorAbove,
  addCursorBelow,
  copyLineDown,
  copyLineUp,
  cursorMatchingBracket,
  deleteLine,
  indentLess,
  indentMore,
  indentSelection,
  insertBlankLine,
  moveLineDown,
  moveLineUp,
  redo,
  selectAll,
  selectLine,
  selectParentSyntax,
  simplifySelection,
  toggleBlockComment,
  toggleComment,
  toggleTabFocusMode,
  undo,
} from "@codemirror/commands";
import {
  findNext,
  findPrevious,
  gotoLine,
  openSearchPanel,
  selectNextOccurrence,
  selectSelectionMatches,
} from "@codemirror/search";
import { foldAll, foldCode, unfoldAll, unfoldCode } from "@codemirror/language";
import { startCompletion } from "@codemirror/autocomplete";
import type { Command as CMCommand } from "@codemirror/view";

export type Group = "Edit" | "Selection" | "Search" | "Fold" | "Files" | "Preview" | "View" | "Room" | "Help";

export interface CommandInfo {
  id: string;
  label: string;
  group: Group;
}

export interface EditorCommand extends CommandInfo {
  kind: "editor";
  run: CMCommand;
}

export interface AppCommand extends CommandInfo {
  kind: "app";
}

const ed = (id: string, label: string, group: Group, run: CMCommand): EditorCommand => ({
  kind: "editor",
  id,
  label,
  group,
  run,
});
const app = (id: string, label: string, group: Group): AppCommand => ({ kind: "app", id, label, group });

export const EDITOR_COMMANDS: EditorCommand[] = [
  ed("undo", "Undo", "Edit", undo),
  ed("redo", "Redo", "Edit", redo),
  ed("toggleComment", "Toggle line comment", "Edit", toggleComment),
  ed("toggleBlockComment", "Toggle block comment", "Edit", toggleBlockComment),
  ed("moveLineUp", "Move line up", "Edit", moveLineUp),
  ed("moveLineDown", "Move line down", "Edit", moveLineDown),
  ed("copyLineUp", "Duplicate line up", "Edit", copyLineUp),
  ed("copyLineDown", "Duplicate line down", "Edit", copyLineDown),
  ed("deleteLine", "Delete line", "Edit", deleteLine),
  ed("insertBlankLine", "Insert line below", "Edit", insertBlankLine),
  ed("indentMore", "Indent", "Edit", indentMore),
  ed("indentLess", "Outdent", "Edit", indentLess),
  ed("reindent", "Re-indent selection", "Edit", indentSelection),
  ed("startCompletion", "Show completions", "Edit", startCompletion),
  ed("selectAll", "Select all", "Selection", selectAll),
  ed("selectLine", "Select line", "Selection", selectLine),
  ed("selectNextOccurrence", "Add next occurrence to selection", "Selection", selectNextOccurrence),
  ed("selectAllOccurrences", "Select all occurrences", "Selection", selectSelectionMatches),
  ed("addCursorAbove", "Add cursor above", "Selection", addCursorAbove),
  ed("addCursorBelow", "Add cursor below", "Selection", addCursorBelow),
  ed("expandSelection", "Expand selection to syntax node", "Selection", selectParentSyntax),
  ed("singleSelection", "Back to one cursor", "Selection", simplifySelection),
  ed("matchingBracket", "Go to matching bracket", "Selection", cursorMatchingBracket),
  ed("find", "Find", "Search", openSearchPanel),
  ed("replace", "Find and replace", "Search", openSearchPanel),
  ed("findNext", "Find next", "Search", findNext),
  ed("findPrevious", "Find previous", "Search", findPrevious),
  ed("gotoLine", "Go to line", "Search", gotoLine),
  ed("fold", "Fold block", "Fold", foldCode),
  ed("unfold", "Unfold block", "Fold", unfoldCode),
  ed("foldAll", "Fold all", "Fold", foldAll),
  ed("unfoldAll", "Unfold all", "Fold", unfoldAll),
  ed("toggleTabFocus", "Toggle Tab moves focus (instead of indenting)", "View", toggleTabFocusMode),
];

export const APP_COMMANDS: AppCommand[] = [
  app("run", "Run preview now", "Preview"),
  app("toggleAutoRun", "Toggle auto-refresh of the preview", "Preview"),
  app("toggleConsole", "Show or hide the console", "Preview"),
  app("clearConsole", "Clear the console", "Preview"),
  app("focusPreview", "Focus the preview", "Preview"),
  app("tabHtml", "Edit HTML", "Files"),
  app("tabCss", "Edit CSS", "Files"),
  app("tabJs", "Edit JavaScript", "Files"),
  app("nextTab", "Next file", "Files"),
  app("prevTab", "Previous file", "Files"),
  app("focusEditor", "Focus the editor", "Files"),
  app("nextPane", "Move focus to the next area", "View"),
  app("palette", "Show all commands", "View"),
  app("settings", "Open settings", "View"),
  app("keybindings", "Edit keyboard shortcuts", "View"),
  app("cycleTheme", "Next theme", "View"),
  app("toggleLayout", "Side by side / stacked layout", "View"),
  app("toggleWrap", "Toggle line wrapping", "View"),
  app("fontBigger", "Bigger editor font", "View"),
  app("fontSmaller", "Smaller editor font", "View"),
  app("fontReset", "Default editor font size", "View"),
  app("copyLink", "Copy the room link", "Room"),
  app("newRoom", "Open a new empty room", "Room"),
  app("help", "Keyboard help", "Help"),
];

export const ALL_COMMANDS: (EditorCommand | AppCommand)[] = [...EDITOR_COMMANDS, ...APP_COMMANDS];
export const COMMAND_BY_ID: ReadonlyMap<string, EditorCommand | AppCommand> = new Map(
  ALL_COMMANDS.map((c) => [c.id, c]),
);

/** CodeMirror functions the presets manage: default keymaps binding them are filtered out (keymaps.ts). */
export const MANAGED_RUNS: ReadonlySet<CMCommand> = new Set(EDITOR_COMMANDS.map((c) => c.run));
