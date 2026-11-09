// The three shared editors (HTML, CSS, JS). Each is a CodeMirror view bound to its Y.Text with
// y-codemirror (remote cursors + selections from the shared awareness). Undo is CodeMirror's own history,
// with remote changes kept out of it (you only undo your own edits) — vim's `u` and emacs' undo use it too.

import {
  Compartment,
  EditorSelection,
  EditorState,
  type Extension,
  Prec,
  Transaction,
} from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { history } from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  acceptCompletion,
  autocompletion,
  closeBrackets,
  closeCompletion,
  completionStatus,
  selectedCompletion,
} from "@codemirror/autocomplete";
import { highlightSelectionMatches, search } from "@codemirror/search";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { javascript, javascriptLanguage } from "@codemirror/lang-javascript";
import { vim } from "@replit/codemirror-vim";
import { emacs } from "@replit/codemirror-emacs";
import "./vendor/emacs-commands.js"; // the package's keys + commands, which minifying drops (see file)
import { yCollab, ySyncAnnotation } from "y-codemirror.next";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { type FileId, MAX_FILE_CHARS } from "../shared/protocol.ts";
import { extraCompletions, type FileTexts } from "./completions.ts";
import { type CaretPoint, crowdedCarets } from "./cursors.ts";
import { errorDisplay } from "./diagnostics.ts";
import { fallbackKeymap, PRESET_BY_ID, type PresetId } from "./keymaps.ts";
import { editorTheme, highlightStyle } from "./themes.ts";
import { tsClient, tsCompletionSource, typescriptEditor, typescriptSupport } from "./ts/client.ts";
import { renameExtension } from "./rename.ts";
import { type MouseMods, mouseMods } from "./keys.ts";

/** The script's language, shared by the room (meta "jsLang"). */
export type ScriptLang = "js" | "ts";

/** What each file is called; the script's entries follow the room's language (setScriptNames). */
export const FILE_LABELS: Record<FileId, string> = { html: "HTML", css: "CSS", js: "JavaScript" };
export const FILE_NAMES: Record<FileId, string> = { html: "index.html", css: "style.css", js: "script.js" };

export function setScriptNames(lang: ScriptLang) {
  FILE_LABELS.js = lang === "ts" ? "TypeScript" : "JavaScript";
  FILE_NAMES.js = lang === "ts" ? "script.ts" : "script.js";
}

/** The file's language, its extra completions and (TypeScript) the types under the mouse. */
function languageExtension(f: FileId, lang: ScriptLang, texts: FileTexts): Extension {
  const ts = f === "js" && lang === "ts";
  return [
    f === "html"
      ? html({ autoCloseTags: true })
      : f === "css"
      ? css()
      : ts
      ? typescriptSupport()
      : javascript(),
    extraCompletions(f, texts, ts ? "ts" : "js"),
    ts
      ? [
        javascriptLanguage.data.of({ autocomplete: tsCompletionSource(tsClient()) }),
        typescriptEditor(tsClient()),
      ]
      : [],
    renameExtension(f, ts ? "ts" : "js"),
    EditorView.contentAttributes.of({
      "aria-label": `${
        f === "js" ? (ts ? "TypeScript" : "JavaScript") : FILE_LABELS[f]
      } code, shared with the room`,
      "aria-describedby": "editor-help",
    }),
  ];
}

/** `cm-hasSelection` on the editor while any range is non-empty (themes.ts: the caret line steps aside). */
const selectionClass = EditorView.editorAttributes.compute(
  ["selection"],
  (
    s,
  ): Record<string, string> => (s.selection.ranges.some((r) => !r.empty) ? { class: "cm-hasSelection" } : {}),
);

/** Remote edits (y-codemirror's sync annotation) never enter the local undo history. */
const remoteNotInHistory = EditorState.transactionExtender.of((tr) =>
  tr.annotation(ySyncAnnotation) !== undefined ? { annotations: Transaction.addToHistory.of(false) } : null
);

/**
 * Per-file limit: a local edit that would grow the file past MAX_FILE_CHARS is refused (deleting is always
 * fine, remote edits pass). The server enforces the same limit by cutting files back.
 */
function fileLimit(onRefused: () => void) {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || tr.annotation(ySyncAnnotation) !== undefined) return tr;
    if (tr.newDoc.length > MAX_FILE_CHARS && tr.newDoc.length > tr.startState.doc.length) {
      onRefused();
      return [];
    }
    return tr;
  });
}

/**
 * Tab takes the highlighted suggestion while the completion list is open (before vim / emacs and the
 * indent-with-Tab fallback); with no list open, Tab indents as before.
 */
const tabAcceptsCompletion = Prec.highest(keymap.of([{
  key: "Tab",
  // at once, however fresh the list (no retry later: a key typed meanwhile would make it miss)
  run: (view) =>
    completionStatus(view.state) === "active" && !!selectedCompletion(view.state) && acceptCompletion(view),
}, {
  key: "Enter",
  // Enter right as the list pops up (typing fast) is a new line, not the suggestion — CodeMirror's own
  // interaction delay, kept for Enter only (Tab above takes the suggestion at once)
  run: (view) => {
    if (
      completionStatus(view.state) !== "active" || Date.now() - (listOpenedAt.get(view) ?? 0) >= ENTER_DELAY
    ) {
      return false;
    }
    closeCompletion(view);
    return false;
  },
}]));

/** When each editor's completion list last opened (for the Enter delay). */
const listOpenedAt = new WeakMap<EditorView, number>();
const ENTER_DELAY = 75;
const trackListOpening = EditorView.updateListener.of((u) => {
  if (completionStatus(u.state) === "active" && completionStatus(u.startState) !== "active") {
    listOpenedAt.set(u.view, Date.now());
  }
});

/**
 * Remote carets that crowd together (another caret, or mine, within CROWD_DISTANCE characters on the same
 * line) get `cm-yCrowded`: their name chips are hidden (themes.ts) and come back on hover. Measured after
 * y-codemirror has drawn its caret widgets; class changes inside widgets are not seen as edits.
 */
const crowdedNames = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {
      this.schedule();
    }
    update(_u: ViewUpdate) {
      this.schedule();
    }
    schedule() {
      this.view.requestMeasure({
        key: this,
        read: (view) => {
          const carets = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-ySelectionCaret")];
          const at = (pos: number): CaretPoint => {
            const l = view.state.doc.lineAt(pos);
            return { line: l.number, col: pos - l.from };
          };
          const points = carets.map((el) => {
            try {
              return at(view.posAtDOM(el));
            } catch {
              return null;
            }
          });
          const mine = view.hasFocus ? at(view.state.selection.main.head) : null;
          return { carets, crowded: crowdedCarets(points, mine) };
        },
        write: ({ carets, crowded }) =>
          carets.forEach((el, i) => el.classList.toggle("cm-yCrowded", crowded[i])),
      });
    }
  },
);

export interface EditorOptions {
  keymap: PresetId;
  tabSize: number;
  lineWrap: boolean;
}

export interface FileOptions {
  /** The script's language (the room's switch); other files ignore it. */
  scriptLang?: ScriptLang;
}

export class SharedEditor {
  readonly view: EditorView;
  private readonly modal = new Compartment();
  private readonly tabs = new Compartment();
  private readonly wrap = new Compartment();
  private readonly lang = new Compartment();
  private scriptLang: ScriptLang;

  constructor(
    readonly file: FileId,
    parent: HTMLElement,
    ytext: Y.Text,
    awareness: Awareness,
    opts: EditorOptions,
    onLimit: (file: FileId) => void = () => {},
    onCursor: (file: FileId, line: number, col: number) => void = () => {},
    private readonly texts: FileTexts = (f) => (f === file ? ytext.toString() : ""),
    fileOpts: FileOptions = {},
  ) {
    this.scriptLang = fileOpts.scriptLang ?? "js";
    const state = EditorState.create({
      doc: ytext.toString(),
      extensions: [
        tabAcceptsCompletion,
        this.modal.of(modalExtension(opts.keymap)),
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        syntaxHighlighting(highlightStyle),
        bracketMatching(),
        closeBrackets(),
        autocompletion({ interactionDelay: 0 }), // Tab / Enter timing: tabAcceptsCompletion
        trackListOpening,
        highlightActiveLine(),
        selectionClass,
        highlightSelectionMatches(),
        search({ top: true }),
        keymap.of(fallbackKeymap()),
        this.lang.of(languageExtension(file, this.scriptLang, texts)),
        this.tabs.of(tabExtension(opts.tabSize)),
        this.wrap.of(opts.lineWrap ? EditorView.lineWrapping : []),
        yCollab(ytext, awareness, { undoManager: false }),
        crowdedNames,
        errorDisplay,
        remoteNotInHistory,
        fileLimit(() => onLimit(file)),
        EditorView.updateListener.of((u) => {
          if (!u.selectionSet && !u.docChanged && !u.focusChanged) return;
          const head = u.state.selection.main.head;
          const line = u.state.doc.lineAt(head);
          onCursor(file, line.number, head - line.from + 1);
        }),
        editorTheme,
      ],
    });
    this.view = new EditorView({ state, parent });
  }

  configure(opts: EditorOptions) {
    this.view.dispatch({
      effects: [
        this.modal.reconfigure(modalExtension(opts.keymap)),
        this.tabs.reconfigure(tabExtension(opts.tabSize)),
        this.wrap.reconfigure(opts.lineWrap ? EditorView.lineWrapping : []),
      ],
    });
  }

  /** The script follows the room's JavaScript / TypeScript switch (highlighting, completions, types). */
  setScriptLang(lang: ScriptLang) {
    if (this.file !== "js" || lang === this.scriptLang) return;
    this.scriptLang = lang;
    this.view.dispatch({ effects: this.lang.reconfigure(languageExtension(this.file, lang, this.texts)) });
  }

  focus() {
    this.view.focus();
  }

  destroy() {
    this.view.destroy();
  }
}

function tabExtension(size: number): Extension {
  return [EditorState.tabSize.of(size), indentUnit.of(" ".repeat(size))];
}

/**
 * The preset's own editor behaviour: vim / emacs own the keys inside the editor first (Prec.highest), and
 * the mouse makes multiple cursors the way that editor does (mouseExtension).
 */
function modalExtension(preset: PresetId): Extension {
  const p = PRESET_BY_ID.get(preset) ?? PRESET_BY_ID.get("vscode")!;
  const mouse = mouseExtension(p.mouse);
  if (p.ext === "vim") return [Prec.highest(vim({ status: true })), mouse];
  if (p.ext === "emacs") return [Prec.highest(emacs()), mouse];
  return mouse;
}

/** Alt+Shift+click (JetBrains): a caret added where clicked, or the caret there removed. */
function addCaretClick(e: MouseEvent, view: EditorView): boolean {
  if (e.button !== 0 || !mouseMods(e, "Alt-Shift")) return false;
  const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
  if (pos === null) return false;
  e.preventDefault();
  const sel = view.state.selection;
  const at = sel.ranges.findIndex((r) => r.empty && r.head === pos);
  view.dispatch({
    selection: at >= 0 && sel.ranges.length > 1
      ? EditorSelection.create(
        sel.ranges.filter((_, i) => i !== at),
        Math.max(0, sel.mainIndex - (at < sel.mainIndex ? 1 : 0)) % (sel.ranges.length - 1),
      )
      : sel.addRange(EditorSelection.cursor(pos)),
    userEvent: "select.pointer",
  });
  view.focus();
  return true;
}

/**
 * Multiple cursors with the mouse: a click with the preset's modifier adds a cursor (Mod+click too, in every
 * preset), a drag with its column modifier selects a column (a box, one cursor per line).
 */
function mouseExtension(m: { addCursor: MouseMods; column: MouseMods }): Extension {
  return [
    EditorView.clickAddsSelectionRange.of((e) => mouseMods(e, m.addCursor) || mouseMods(e, "Mod")),
    // with Shift in the gesture (JetBrains Alt+Shift+click), CodeMirror would extend the selection instead:
    // add (or, on an existing caret, remove) the caret here ourselves
    m.addCursor === "Alt-Shift" ? EditorView.domEventHandlers({ mousedown: addCaretClick }) : [],
    rectangularSelection({ eventFilter: (e) => e.button === 0 && mouseMods(e, m.column) }),
    // the crosshair tells a column drag is ready (only where one key alone means it)
    m.column === "Alt" ? crosshairCursor({ key: "Alt" }) : [],
  ];
}
