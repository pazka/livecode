// The editor's side of TypeScript: starts the worker (/ts-worker.js) the first time a room's script is
// TypeScript, and turns its answers into CodeMirror completions (DOM types, the room's own interfaces,
// classes, types …, event names inside `addEventListener("…")`), the type under the mouse, and the
// "Show type" command (keyboard). Type errors and the JavaScript the preview runs are asked for by main.ts.

import {
  completeFromList,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
  ifNotIn,
} from "@codemirror/autocomplete";
import { LanguageSupport, syntaxTree } from "@codemirror/language";
import { type Extension, StateEffect, StateField } from "@codemirror/state";
import { EditorView, hoverTooltip, showTooltip, type Tooltip } from "@codemirror/view";
import { typescriptLanguage, typescriptSnippets } from "@codemirror/lang-javascript";
import type { TsApi, TsMethod, TsRequest, TsResponse } from "./protocol.ts";
import type { CompletionEntry } from "./service.ts";

type Result<M extends TsMethod> = ReturnType<TsApi[M]>;

/** Requests to the TypeScript worker. The worker starts on the first request. */
export class TsClient {
  private worker: Worker | null = null;
  private failed: string | null = null;
  private next = 1;
  private readonly waiting = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  /** Resolves with the TypeScript version once the worker has loaded. */
  ready: Promise<string> | null = null;

  constructor(private readonly url: string) {}

  /** True once the worker could not be started (no Worker, blocked, script missing). */
  get broken(): boolean {
    return this.failed !== null;
  }

  start(): Promise<string> {
    if (this.ready) return this.ready;
    this.ready = new Promise<string>((resolve, reject) => {
      try {
        this.worker = new Worker(this.url, { type: "module", name: "typescript" });
      } catch (e) {
        this.fail(`TypeScript could not start: ${e instanceof Error ? e.message : e}`);
        return reject(new Error(this.failed!));
      }
      this.worker.onmessage = (e: MessageEvent<TsResponse>) => {
        const m = e.data;
        if ("ready" in m) return resolve(m.ready);
        const w = this.waiting.get(m.id);
        if (!w) return;
        this.waiting.delete(m.id);
        if ("error" in m) w.fail(new Error(m.error));
        else w.ok(m.result);
      };
      this.worker.onerror = (e) => {
        e.preventDefault();
        this.fail(`TypeScript could not be loaded${e.message ? `: ${e.message}` : ""}`);
        reject(new Error(this.failed!));
      };
    });
    this.ready.catch(() => {});
    return this.ready;
  }

  private fail(msg: string) {
    this.failed = msg;
    this.worker?.terminate();
    this.worker = null;
    for (const w of this.waiting.values()) w.fail(new Error(msg));
    this.waiting.clear();
  }

  call<M extends TsMethod>(method: M, ...args: Parameters<TsApi[M]>): Promise<Result<M>> {
    if (this.failed) return Promise.reject(new Error(this.failed));
    this.start();
    const id = this.next++;
    return new Promise<Result<M>>((ok, fail) => {
      this.waiting.set(id, { ok: ok as (v: unknown) => void, fail });
      const req: TsRequest<M> = { id, method, args };
      this.worker!.postMessage(req);
    });
  }
}

let client: TsClient | null = null;

/** The page's TypeScript client (the worker's address is in index.html, with its content hash). */
export function tsClient(): TsClient {
  if (!client) {
    const url = document.querySelector<HTMLMetaElement>('meta[name="livecode-ts-worker"]')?.content;
    client = new TsClient(url || "/ts-worker.js");
  }
  return client;
}

// ---------- completions ----------

/** TypeScript kinds → CodeMirror's completion icons. */
const KIND: Record<string, string> = {
  method: "method",
  call: "method",
  construct: "method",
  function: "function",
  "local function": "function",
  property: "property",
  getter: "property",
  setter: "property",
  index: "property",
  "JSX attribute": "property",
  var: "variable",
  let: "variable",
  "local var": "variable",
  parameter: "variable",
  alias: "variable",
  const: "constant",
  "enum member": "constant",
  class: "class",
  constructor: "class",
  interface: "interface",
  type: "type",
  "primitive type": "type",
  "type parameter": "type",
  enum: "enum",
  module: "namespace",
  "external module name": "namespace",
  keyword: "keyword",
  string: "text",
};

/** TypeScript's rank ("10" locals … "15" globals and keywords, "z…" deprecated) as a CodeMirror boost. */
export function boostOf(e: Pick<CompletionEntry, "sort" | "deprecated">): number {
  if (e.deprecated) return -60;
  const n = Number.parseInt(e.sort, 10);
  return Number.isFinite(n) ? Math.max(-40, Math.min(40, (15 - n) * 8)) : -20;
}

/** Where completing makes no sense (lang-javascript's own list, without strings: event names live there). */
const NO_COMPLETE = [
  "LineComment",
  "BlockComment",
  "RegExp",
  "VariableDefinition",
  "TypeDefinition",
  "Label",
  "PropertyDefinition",
  "PrivatePropertyDefinition",
];

function info(c: TsClient, text: string, pos: number, e: CompletionEntry): Completion["info"] {
  return async () => {
    const d = await c.call("details", text, pos, e.name, e.source).catch(() => null);
    if (!d) return null;
    return typeBox(d.display, d.docs);
  };
}

/** A box with a type signature (code) and its documentation (text). */
export function typeBox(display: string, docs: string): HTMLElement {
  const box = document.createElement("div");
  box.className = "cm-lc-typeInfo";
  const code = document.createElement("code");
  code.textContent = display;
  box.append(code);
  if (docs) {
    const p = document.createElement("p");
    p.textContent = docs
      .replace(/\*\*`?|`?\*\*/g, "")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, "$1") // markdown links: their text
      .slice(0, 600);
    box.append(p);
  }
  return box;
}

/** Completions from the TypeScript language service. */
export function tsCompletionSource(c: TsClient): CompletionSource {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const node = syntaxTree(ctx.state).resolveInner(ctx.pos, -1);
    if (NO_COMPLETE.includes(node.name)) return null;
    const inString = node.name === "String" || node.name === "TemplateString";
    const word = ctx.matchBefore(inString ? /[\w$-]*$/ : /[\w$]*$/);
    const before = ctx.state.sliceDoc(Math.max(0, (word?.from ?? ctx.pos) - 1), word?.from ?? ctx.pos);
    const trigger = before === "." || (inString && /["'`]/.test(before)) ? before : undefined;
    if (!ctx.explicit && (!word || word.from === word.to) && !trigger) return null;
    if (inString && !trigger) return null; // only right inside the quotes of a string being typed
    const text = ctx.state.doc.toString();
    const r = await c.call("completions", text, ctx.pos, trigger).catch(() => null);
    if (!r || ctx.aborted || !r.entries.length) return null;
    const options: Completion[] = r.entries.map((e) => ({
      label: e.name,
      type: KIND[e.kind] ?? "text",
      detail: e.optional ? "optional" : undefined,
      boost: boostOf(e),
      info: info(c, text, ctx.pos, e),
    }));
    return {
      from: r.from,
      to: Math.max(ctx.pos, r.to),
      options,
      validFor: inString ? /^[\w$-]*$/ : /^[\w$]*$/,
    };
  };
}

/** TypeScript highlighting + the package's snippets (`for`, `if`, `interface` …); the words come from TS. */
export function typescriptSupport(): LanguageSupport {
  return new LanguageSupport(typescriptLanguage, [
    typescriptLanguage.data.of({
      autocomplete: ifNotIn(
        [...NO_COMPLETE, "String", "TemplateString", "."],
        completeFromList(typescriptSnippets),
      ),
    }),
  ]);
}

// ---------- the type at a position ----------

/** Hover: the type of what is under the mouse. */
function typeHover(c: TsClient): Extension {
  return hoverTooltip(async (view, pos) => {
    const t = await c.call("typeAt", view.state.doc.toString(), pos).catch(() => null);
    if (!t) return null;
    return {
      pos: t.from,
      end: t.to,
      above: true,
      create: () => ({ dom: typeBox(t.display, t.docs) }),
    };
  }, { hoverTime: 350 });
}

const setTypeTip = StateEffect.define<Tooltip | null>();

/** The tooltip of the "Show type" command; closed by any edit or caret move. */
const typeTipField = StateField.define<Tooltip | null>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setTypeTip)) return e.value;
    return tr.docChanged || tr.selection ? null : v;
  },
  provide: (f) => showTooltip.from(f),
});

/**
 * "Show type at the cursor" (keyboard): the same box as the hover, under the caret, also announced to
 * screen readers through `announce`.
 */
export function showTypeAtCursor(view: EditorView, announce: (msg: string) => void = () => {}): boolean {
  if (view.state.field(typeTipField, false) === undefined) return false; // not a TypeScript editor
  const c = tsClient();
  const pos = view.state.selection.main.head;
  const doc = view.state.doc;
  c.call("typeAt", doc.toString(), pos).then((t) => {
    if (view.state.doc !== doc || view.state.selection.main.head !== pos) return;
    if (!t) {
      announce("No type here");
      return;
    }
    announce(t.display);
    view.dispatch({
      effects: setTypeTip.of({
        pos,
        above: false,
        create: () => ({ dom: typeBox(t.display, t.docs) }),
      }),
    });
  }, () => announce("TypeScript is not available"));
  return true;
}

/** Everything a TypeScript script editor adds: the type under the mouse and the "Show type" box. */
export function typescriptEditor(c: TsClient): Extension {
  return [
    typeHover(c),
    typeTipField,
    EditorView.domEventHandlers({
      keydown: (e, view) => {
        if (e.key !== "Escape" || !view.state.field(typeTipField)) return false;
        view.dispatch({ effects: setTypeTip.of(null) });
        return true;
      },
    }),
  ];
}
