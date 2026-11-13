// TypeScript for the script file (owner, 2026-11-06: "use typescript too, so that autocompletion works with
// typescript objects and all the basic TS DOM definitions … same for custom made objects, types, interfaces").
// One TypeScript language service over one file, the room's script, with the browser's own type definitions
// (lib.esnext + lib.dom): completions, the type at a position, type errors, and the JavaScript the preview runs.
// Pure: `ts` and the lib files are passed in. Runs in a worker (worker.ts); tested in tests/typescript_test.ts.

import type TS from "typescript";

/** The type definitions every script sees (and every lib file they reference: scripts/tslibs.ts). */
export const LIB_ROOTS = [
  "lib.esnext.d.ts",
  "lib.dom.d.ts",
  "lib.dom.iterable.d.ts",
  "lib.dom.asynciterable.d.ts",
] as const;

const SCRIPT = "/script.ts";
/** The script of a JavaScript room (rename only): read as JavaScript, never type-checked. */
const SCRIPT_JS = "/script.js";
const ENV = "/livecode-env.d.ts";
const LIB_DIR = "/lib/";
/** Imports from a URL (`import confetti from "https://esm.sh/canvas-confetti"`) are typed `any`. */
const ENV_SOURCE = 'declare module "https://*";\ndeclare module "http://*";\n';
/** Diagnostics left out: an import nobody can resolve here (a relative path, a bare package name). */
const IGNORED_CODES = new Set([2307, 2792]);

export interface Completions {
  /** Start of the text the options replace. */
  from: number;
  to: number;
  entries: CompletionEntry[];
}

export interface CompletionEntry {
  name: string;
  /** TypeScript's kind (`method`, `property`, `const`, `interface` …). */
  kind: string;
  /** TypeScript's rank: locals "10"/"11", members "11"/"12", globals and keywords "15" … */
  sort: string;
  deprecated?: boolean;
  optional?: boolean;
  /** For details(): which declaration (auto-import data is never asked for). */
  source?: string;
}

export interface TypeInfo {
  /** `(method) Document.getElementById(elementId: string): HTMLElement | null` */
  display: string;
  docs: string;
  from: number;
  to: number;
}

export interface TypeError {
  /** 1-based. */
  line: number;
  /** 1-based. */
  col: number;
  message: string;
  code: number;
}

export type RenameResult =
  | {
    ok: true;
    /** The name as it is now. */
    name: string;
    /** TypeScript's kind of the symbol (`const`, `function`, `class`, `property` …). */
    kind: string;
    /** The span the caret is in. */
    from: number;
    to: number;
    /** Every place to rename, in order. */
    ranges: { from: number; to: number }[];
  }
  | { ok: false; message: string };

export interface Transpiled {
  js: string;
  /** Source map (v3) of `js` back to the TypeScript text. */
  map: string;
}

export class ScriptService {
  private text = "";
  private version = 0;
  private jsText = "";
  private jsVersion = 0;
  private readonly ls: TS.LanguageService;
  private readonly snapshots = new Map<string, TS.IScriptSnapshot>();
  private readonly options: TS.CompilerOptions;

  constructor(private readonly ts: typeof TS, private readonly libs: Readonly<Record<string, string>>) {
    this.options = {
      target: ts.ScriptTarget.ES2022,
      lib: [...LIB_ROOTS],
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      // the file is checked as a module: its top-level names never clash with the DOM's globals (`name`,
      // `status`, `close` …), as a classic script's top-level `let` / `const` don't at run time either
      moduleDetection: ts.ModuleDetectionKind.Force,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      isolatedModules: true,
      allowJs: true,
      checkJs: false,
      types: [],
    };
    const read = (f: string): string | undefined =>
      f === SCRIPT
        ? this.text
        : f === SCRIPT_JS
        ? this.jsText
        : f === ENV
        ? ENV_SOURCE
        : f.startsWith(LIB_DIR)
        ? libs[f.slice(5)]
        : undefined;
    const host: TS.LanguageServiceHost = {
      getCompilationSettings: () => this.options,
      getScriptFileNames: () => [SCRIPT, SCRIPT_JS, ENV],
      getScriptVersion: (
        f,
      ) => (f === SCRIPT ? String(this.version) : f === SCRIPT_JS ? String(this.jsVersion) : "0"),
      getScriptSnapshot: (f) => {
        if (f === SCRIPT) return ts.ScriptSnapshot.fromString(this.text);
        if (f === SCRIPT_JS) return ts.ScriptSnapshot.fromString(this.jsText);
        let s = this.snapshots.get(f);
        if (!s) {
          const t = read(f);
          if (t === undefined) return undefined;
          s = ts.ScriptSnapshot.fromString(t);
          this.snapshots.set(f, s);
        }
        return s;
      },
      getCurrentDirectory: () => "/",
      getDefaultLibFileName: () => LIB_DIR + "lib.d.ts",
      fileExists: (f) => read(f) !== undefined,
      readFile: read,
      directoryExists: (d) => d === "/" || d === "/lib",
      getDirectories: () => [],
      useCaseSensitiveFileNames: () => true,
    };
    this.ls = ts.createLanguageService(host, ts.createDocumentRegistry());
  }

  private use(text: string) {
    if (text !== this.text) {
      this.text = text;
      this.version++;
    }
  }

  /**
   * Rename the symbol at `pos`: every place it is used in the script (scope-aware: another `x` elsewhere is
   * not touched), or why it can't be renamed (a keyword, something of the browser's own types …).
   */
  rename(text: string, pos: number, lang: "ts" | "js" = "ts"): RenameResult {
    let file = SCRIPT;
    if (lang === "js") {
      file = SCRIPT_JS;
      if (text !== this.jsText) {
        this.jsText = text;
        this.jsVersion++;
      }
    } else this.use(text);
    const info = this.ls.getRenameInfo(file, pos, { allowRenameOfImportPath: false });
    if (!info.canRename) return { ok: false, message: info.localizedErrorMessage };
    const locs = this.ls.findRenameLocations(file, pos, false, false, {
      providePrefixAndSuffixTextForRename: false,
    });
    const ranges = (locs ?? [])
      .filter((l) => l.fileName === file)
      .map((l) => ({ from: l.textSpan.start, to: l.textSpan.start + l.textSpan.length }))
      .sort((a, b) => a.from - b.from);
    if (!ranges.length) return { ok: false, message: "Nothing to rename here" };
    return {
      ok: true,
      name: info.displayName,
      kind: info.kind,
      from: info.triggerSpan.start,
      to: info.triggerSpan.start + info.triggerSpan.length,
      ranges,
    };
  }

  /** Completions at `pos` (an offset in `text`). */
  completions(text: string, pos: number, triggerCharacter?: string): Completions | null {
    this.use(text);
    const trigger = triggerCharacter && [".", '"', "'", "`", "<", "#"].includes(triggerCharacter)
      ? triggerCharacter as TS.CompletionsTriggerCharacter
      : undefined;
    const r = this.ls.getCompletionsAtPosition(SCRIPT, pos, {
      triggerCharacter: trigger,
      includeCompletionsWithInsertText: false,
      includeCompletionsForModuleExports: false,
      includeCompletionsWithSnippetText: false,
      includeAutomaticOptionalChainCompletions: false,
    });
    if (!r) return null;
    const span = r.optionalReplacementSpan;
    let from = pos, to = pos;
    if (span && span.start <= pos && pos <= span.start + span.length) {
      from = span.start;
      to = span.start + span.length;
    } else {
      while (from > 0 && /[\w$]/.test(text[from - 1])) from--;
    }
    const entries: CompletionEntry[] = [];
    for (const e of r.entries) {
      if (e.hasAction || e.insertText !== undefined || e.isSnippet) continue;
      const mods = e.kindModifiers ?? "";
      const entry: CompletionEntry = { name: e.name, kind: e.kind, sort: e.sortText };
      if (/\bdeprecated\b/.test(mods)) entry.deprecated = true;
      if (/\boptional\b/.test(mods)) entry.optional = true;
      if (e.source) entry.source = e.source;
      entries.push(entry);
    }
    return { from, to, entries };
  }

  /** The signature and documentation of one completion. */
  details(
    text: string,
    pos: number,
    name: string,
    source?: string,
  ): { display: string; docs: string } | null {
    this.use(text);
    const d = this.ls.getCompletionEntryDetails(SCRIPT, pos, name, undefined, source, undefined, undefined);
    if (!d) return null;
    return { display: this.ts.displayPartsToString(d.displayParts), docs: docsOf(this.ts, d) };
  }

  /** The type of what is at `pos` (hover, "Show type"). */
  typeAt(text: string, pos: number): TypeInfo | null {
    this.use(text);
    const q = this.ls.getQuickInfoAtPosition(SCRIPT, pos);
    if (!q) return null;
    return {
      display: this.ts.displayPartsToString(q.displayParts),
      docs: docsOf(this.ts, q),
      from: q.textSpan.start,
      to: q.textSpan.start + q.textSpan.length,
    };
  }

  /** Syntax and type errors of the script, first ones first. */
  errors(text: string): TypeError[] {
    this.use(text);
    const all = [...this.ls.getSyntacticDiagnostics(SCRIPT), ...this.ls.getSemanticDiagnostics(SCRIPT)];
    const out: TypeError[] = [];
    for (const d of all) {
      if (d.category !== this.ts.DiagnosticCategory.Error || IGNORED_CODES.has(d.code)) continue;
      const at = d.start ?? 0;
      const lc = lineCol(text, at);
      out.push({ ...lc, code: d.code, message: this.ts.flattenDiagnosticMessageText(d.messageText, "\n") });
    }
    return out.sort((a, b) => a.line - b.line || a.col - b.col);
  }

  /**
   * The JavaScript the preview runs: types removed, nothing else changed (same ES version as the browser,
   * imports kept for a module script), with its source map.
   */
  transpile(text: string): Transpiled {
    const ts = this.ts;
    const out = ts.transpileModule(text, {
      fileName: "script.ts",
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        sourceMap: true,
        isolatedModules: true,
        useDefineForClassFields: true,
      },
    });
    return {
      js: out.outputText.replace(/\n?\/\/# sourceMappingURL=\S*\s*$/, "\n"),
      map: out.sourceMapText ?? "",
    };
  }
}

function lineCol(text: string, pos: number): { line: number; col: number } {
  const before = text.slice(0, pos);
  const nl = before.lastIndexOf("\n");
  return { line: before.split("\n").length, col: pos - nl };
}

function docsOf(
  ts: typeof TS,
  d: { documentation?: TS.SymbolDisplayPart[]; tags?: TS.JSDocTagInfo[] },
): string {
  const doc = ts.displayPartsToString(d.documentation ?? []);
  const tags = (d.tags ?? [])
    .filter((t) => t.name !== "see" && t.name !== "link")
    .map((t) => `@${t.name}${t.text ? " " + ts.displayPartsToString(t.text) : ""}`);
  return [doc, ...tags].filter(Boolean).join("\n").slice(0, 2000);
}
