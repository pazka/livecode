// The three shared editors (HTML, CSS, JS). Each is a CodeMirror view bound to its Y.Text with
// y-codemirror (remote cursors + selections from the shared awareness). Undo is CodeMirror's own history,
// with remote changes kept out of it (you only undo your own edits) — vim's `u` and emacs' undo use it too.

import { Compartment, EditorState, type Extension, Prec, Transaction } from "@codemirror/state";
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
} from "@codemirror/view";
import { history } from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { autocompletion, closeBrackets } from "@codemirror/autocomplete";
import { highlightSelectionMatches, search } from "@codemirror/search";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { javascript } from "@codemirror/lang-javascript";
import { vim } from "@replit/codemirror-vim";
import { emacs } from "@replit/codemirror-emacs";
import "./vendor/emacs-commands.js"; // the package's keys + commands, which minifying drops (see file)
import { yCollab, ySyncAnnotation } from "y-codemirror.next";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { type FileId, MAX_FILE_CHARS } from "../shared/protocol.ts";
import { fallbackKeymap, PRESET_BY_ID, type PresetId } from "./keymaps.ts";
import { editorTheme, highlightStyle } from "./themes.ts";

export const FILE_LABELS: Record<FileId, string> = { html: "HTML", css: "CSS", js: "JavaScript" };

const language = (f: FileId): Extension =>
  f === "html" ? html({ autoCloseTags: true }) : f === "css" ? css() : javascript();

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

export interface EditorOptions {
  keymap: PresetId;
  tabSize: number;
  lineWrap: boolean;
}

export class SharedEditor {
  readonly view: EditorView;
  private readonly modal = new Compartment();
  private readonly tabs = new Compartment();
  private readonly wrap = new Compartment();

  constructor(
    readonly file: FileId,
    parent: HTMLElement,
    ytext: Y.Text,
    awareness: Awareness,
    opts: EditorOptions,
    onLimit: (file: FileId) => void = () => {},
    onCursor: (file: FileId, line: number, col: number) => void = () => {},
  ) {
    const state = EditorState.create({
      doc: ytext.toString(),
      extensions: [
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
        autocompletion(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        selectionClass,
        highlightSelectionMatches(),
        search({ top: true }),
        keymap.of(fallbackKeymap()),
        language(file),
        this.tabs.of(tabExtension(opts.tabSize)),
        this.wrap.of(opts.lineWrap ? EditorView.lineWrapping : []),
        yCollab(ytext, awareness, { undoManager: false }),
        remoteNotInHistory,
        fileLimit(() => onLimit(file)),
        EditorView.updateListener.of((u) => {
          if (!u.selectionSet && !u.docChanged && !u.focusChanged) return;
          const head = u.state.selection.main.head;
          const line = u.state.doc.lineAt(head);
          onCursor(file, line.number, head - line.from + 1);
        }),
        editorTheme,
        EditorView.contentAttributes.of({
          "aria-label": `${FILE_LABELS[file]} code, shared with the room`,
          "aria-describedby": "editor-help",
        }),
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

/** vim / emacs own the keys inside the editor first (Prec.highest); other presets add nothing here. */
function modalExtension(preset: PresetId): Extension {
  const ext = PRESET_BY_ID.get(preset)?.ext;
  if (ext === "vim") return Prec.highest(vim({ status: true }));
  if (ext === "emacs") return Prec.highest(emacs());
  return [];
}
