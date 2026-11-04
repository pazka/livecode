// Themes are CSS custom properties on <html data-theme="…"> (web/app.css). The editor theme and the syntax
// colours below only reference those variables, so switching theme is one attribute, for the whole UI and
// all three editors at once. tests/themes_test.ts checks every theme in app.css against WCAG contrast.

import { EditorView } from "@codemirror/view";
import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

export interface ThemeInfo {
  id: string;
  label: string;
  dark: boolean;
  highContrast: boolean;
}

export const THEMES: ThemeInfo[] = [
  { id: "light", label: "Light", dark: false, highContrast: false },
  { id: "dark", label: "Dark", dark: true, highContrast: false },
  { id: "dim", label: "Dim", dark: true, highContrast: false },
  { id: "sepia", label: "Sepia", dark: false, highContrast: false },
  { id: "solarized-light", label: "Solarized light", dark: false, highContrast: false },
  { id: "solarized-dark", label: "Solarized dark", dark: true, highContrast: false },
  { id: "hc-dark", label: "High contrast dark", dark: true, highContrast: true },
  { id: "hc-light", label: "High contrast light", dark: false, highContrast: true },
];

export const THEME_CHOICES: { id: string; label: string }[] = [
  { id: "system", label: "Follow the system (light, dark, high contrast)" },
  ...THEMES,
];

export function isThemeChoice(s: unknown): s is string {
  return typeof s === "string" && THEME_CHOICES.some((c) => c.id === s);
}

/** "system" → a concrete theme from the OS preferences (prefers-contrast / forced-colors / color-scheme). */
export function resolveTheme(choice: string, mq: (q: string) => boolean): string {
  if (choice !== "system") return THEMES.some((x) => x.id === choice) ? choice : "light";
  const dark = mq("(prefers-color-scheme: dark)");
  if (mq("(prefers-contrast: more)") || mq("(forced-colors: active)")) return dark ? "hc-dark" : "hc-light";
  return dark ? "dark" : "light";
}

export const editorTheme = EditorView.theme({
  "&": {
    color: "var(--fg)",
    backgroundColor: "var(--bg)",
    height: "100%",
    fontSize: "var(--editor-font-size, 14px)",
  },
  ".cm-scroller": {
    fontFamily: "var(--mono)",
    lineHeight: "1.55",
  },
  ".cm-content": { caretColor: "var(--cursor)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--cursor)", borderLeftWidth: "2px" },
  "&.cm-focused": { outline: "none" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--sel) !important",
  },
  ".cm-activeLine": { backgroundColor: "var(--line)" },
  // CodeMirror paints the selection BEHIND the text lines: an opaque caret-line background would hide it
  // (owner bug X.18). While something is selected the caret line is not highlighted — like JetBrains.
  "&.cm-hasSelection .cm-activeLine": { backgroundColor: "transparent" },
  ".cm-activeLineGutter": { backgroundColor: "var(--line)", color: "var(--fg)" },
  ".cm-gutters": {
    backgroundColor: "var(--bg)",
    color: "var(--muted)",
    borderRight: "1px solid var(--border)",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 0.6em 0 0.8em" },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--panel)",
    color: "var(--fg)",
    border: "1px solid var(--ctl)",
  },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    outline: "1px solid var(--focus)",
    backgroundColor: "transparent",
  },
  ".cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket": {
    outline: "1px solid var(--danger)",
  },
  ".cm-searchMatch": { outline: "1px solid var(--warn)", backgroundColor: "transparent" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--sel)" },
  ".cm-selectionMatch": { backgroundColor: "transparent", outline: "1px dotted var(--muted)" },
  ".cm-tooltip": {
    backgroundColor: "var(--panel)",
    color: "var(--fg)",
    border: "1px solid var(--ctl)",
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--accent)",
    color: "var(--accent-fg)",
  },
  ".cm-panels": { backgroundColor: "var(--panel)", color: "var(--fg)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  ".cm-panel input, .cm-panel button, .cm-textfield, .cm-button": {
    font: "inherit",
    color: "var(--fg)",
    backgroundColor: "var(--bg)",
    border: "1px solid var(--ctl)",
    borderRadius: "4px",
    backgroundImage: "none",
  },
  ".cm-panel input:focus-visible, .cm-panel button:focus-visible, .cm-textfield:focus-visible": {
    outline: "3px solid var(--focus)",
    outlineOffset: "1px",
  },
  ".cm-vim-panel, .cm-vim-panel input": {
    fontFamily: "var(--mono)",
    color: "var(--fg)",
    backgroundColor: "var(--panel)",
  },
  ".cm-fat-cursor": { background: "var(--cursor) !important", color: "var(--bg) !important" },
  "&:not(.cm-focused) .cm-fat-cursor": { background: "none !important", outline: "1px solid var(--cursor)" },
  // shared cursors (y-codemirror): the name label uses black text on the user's colour (palette checked)
  ".cm-ySelectionCaret": { borderLeftWidth: "2px", borderRightWidth: "0" },
  ".cm-ySelectionInfo": {
    color: "#000",
    fontFamily: "var(--ui-font)",
    fontWeight: "600",
    fontSize: "0.75em",
    opacity: "1",
    padding: "1px 4px",
    borderRadius: "3px 3px 3px 0",
    top: "-1.35em",
    transitionDelay: "0s",
  },
});

export const highlightStyle = HighlightStyle.define([
  {
    tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword],
    color: "var(--tok-keyword)",
  },
  { tag: [t.string, t.special(t.string), t.regexp, t.escape], color: "var(--tok-string)" },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit, t.color], color: "var(--tok-number)" },
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
    color: "var(--tok-comment)",
    fontStyle: "italic",
  },
  { tag: [t.tagName, t.angleBracket], color: "var(--tok-tag)" },
  { tag: [t.attributeName], color: "var(--tok-attr)" },
  { tag: [t.attributeValue], color: "var(--tok-string)" },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: "var(--tok-prop)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--tok-func)" },
  { tag: [t.typeName, t.className, t.namespace, t.labelName], color: "var(--tok-type)" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "var(--tok-op)" },
  { tag: [t.variableName, t.definition(t.variableName)], color: "var(--fg)" },
  { tag: [t.invalid], color: "var(--tok-invalid)", textDecoration: "underline wavy" },
  { tag: t.heading, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.link, textDecoration: "underline" },
]);

/** Peer colours: ≥ 3:1 against every theme background, black name label ≥ 4.5:1 (themes_test.ts). */
export const PEER_COLORS = [
  "#f42525",
  "#ce5c0b",
  "#9d7808",
  "#408f08",
  "#089136",
  "#078d76",
  "#0987b1",
  "#237af3",
  "#7e66f7",
  "#af4cf6",
  "#dc0cdc",
  "#f20d80",
];
