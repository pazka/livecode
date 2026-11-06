// The live preview: debounced ("anti-rebond") refreshes, one fresh sandboxed frame per version (swapped in
// only once it is alive, so the page never flashes blank), console forwarding, and freeze recovery.

import { JS_SOURCE_URL, scriptLine } from "./compose.ts";

export interface ConsoleEntry {
  level: "log" | "info" | "warn" | "error" | "debug";
  text: string;
  at: number;
}

/** An error of the user's script, at its line (1-based) and column (1-based, 0 = unknown). */
export interface PageError {
  line: number;
  col: number;
  text: string;
}

/** One version of the page: the document, and for a TypeScript script the way back to its lines. */
export interface Built {
  html: string;
  /** The script's line / column (1-based, col 0 = unknown) in the source the room wrote. */
  toSource?: (line: number, col: number) => { line: number; col: number } | null;
  /** How the console names the script's lines ("JS line 3" / "TS line 5"). */
  label?: string;
}

export interface PreviewEvents {
  console(e: ConsoleEntry): void;
  /** A positioned error of the version being shown (`pending`: of the one about to be). */
  pageError?(e: PageError, pending: boolean): void;
  /** A new version starts loading (the next `rendered` shows it). */
  started?(): void;
  /** A new version is on screen. */
  rendered(at: number): void;
}

const SANDBOX = "allow-scripts allow-modals allow-pointer-lock";
const ALIVE_KEY = "livecode.preview.alive";
const CLEAN_KEY = "livecode.preview.clean";

/**
 * True when the previous page load ended while a preview was running and the page never closed cleanly —
 * a preview that froze the tab. The caller then starts with auto-refresh paused. Resets the markers.
 */
export function previousRunFroze(): boolean {
  try {
    const froze = sessionStorage.getItem(ALIVE_KEY) !== null && sessionStorage.getItem(CLEAN_KEY) === null;
    sessionStorage.removeItem(ALIVE_KEY);
    sessionStorage.removeItem(CLEAN_KEY);
    addEventListener("pagehide", () => sessionStorage.setItem(CLEAN_KEY, "1"));
    addEventListener("pageshow", () => sessionStorage.removeItem(CLEAN_KEY));
    return froze;
  } catch {
    return false;
  }
}

export class Preview {
  private current: HTMLIFrameElement | null = null;
  private pending: HTMLIFrameElement | null = null;
  private pendingBuilt: Built = { html: "" };
  private lastHtml: string | null = null;
  private currentBuilt: Built = { html: "" };
  private timer: number | undefined;
  private builds = 0;
  private swapTimer: number | undefined;
  private lastAliveWrite = 0;

  constructor(
    private readonly host: HTMLElement,
    /** The page to show; a promise when it takes a step first (TypeScript → JavaScript). */
    private readonly build: () => Built | string | Promise<Built>,
    private readonly on: PreviewEvents,
  ) {
    addEventListener("message", (e) => this.onMessage(e));
  }

  /** Debounced refresh after an edit: waits `delayMs` after the last change. */
  schedule(delayMs: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.render(false), delayMs);
  }

  cancel() {
    clearTimeout(this.timer);
  }

  /** Render now; `force` re-runs even when nothing changed (Run command). */
  render(force: boolean) {
    clearTimeout(this.timer);
    const n = ++this.builds;
    let b: Built | string | Promise<Built>;
    try {
      b = this.build();
    } catch (e) {
      return this.buildFailed(e);
    }
    if (b instanceof Promise) {
      // only the newest build is shown; an older one that resolves late is dropped
      b.then(
        (v) => n === this.builds && this.show(v, force),
        (e) => n === this.builds && this.buildFailed(e),
      );
    } else this.show(typeof b === "string" ? { html: b } : b, force);
  }

  private buildFailed(e: unknown) {
    this.on.console({
      level: "error",
      text: `The page could not be prepared: ${e instanceof Error ? e.message : String(e)}`,
      at: Date.now(),
    });
  }

  private show(built: Built, force: boolean) {
    const html = built.html;
    if (!force && html === this.lastHtml) return;
    this.lastHtml = html;
    // a newer version replaces a frame that is still loading
    if (this.pending) this.pending.remove();
    const f = document.createElement("iframe");
    f.className = "preview-frame pending";
    f.setAttribute("sandbox", SANDBOX);
    f.setAttribute("title", "Live preview of the page");
    f.setAttribute("tabindex", "-1");
    f.setAttribute("aria-hidden", "true");
    f.src = "/preview";
    this.pending = f;
    this.pendingBuilt = built;
    this.on.started?.();
    this.host.appendChild(f);
    clearTimeout(this.swapTimer);
    // a page that never reports alive (it hangs at once, or blocks scripts) is still shown after 1.5 s
    this.swapTimer = setTimeout(() => this.swap(f), 1500);
  }

  private swap(f: HTMLIFrameElement) {
    if (this.pending !== f) return;
    clearTimeout(this.swapTimer);
    this.pending = null;
    this.currentBuilt = this.pendingBuilt;
    const old = this.current;
    this.current = f;
    f.classList.remove("pending");
    f.removeAttribute("aria-hidden");
    f.setAttribute("tabindex", "0");
    if (old) {
      const hadFocus = document.activeElement === old;
      old.remove();
      if (hadFocus) f.focus();
    }
    this.on.rendered(Date.now());
  }

  focus() {
    this.current?.focus();
  }

  private onMessage(e: MessageEvent) {
    const d = e.data as { __lc?: number; type?: string; level?: string; text?: string } | null;
    if (!d || d.__lc !== 1) return;
    const fromPending = this.pending !== null && e.source === this.pending.contentWindow;
    const fromCurrent = this.current !== null && e.source === this.current.contentWindow;
    if (!fromPending && !fromCurrent) return;
    if (d.type === "ready" && fromPending) {
      this.pending!.contentWindow!.postMessage(
        { __lc: 1, type: "render", html: this.pendingBuilt.html },
        "*",
      );
    } else if (d.type === "alive") {
      if (fromPending) this.swap(this.pending!);
      const now = Date.now();
      if (now - this.lastAliveWrite > 1000) {
        this.lastAliveWrite = now;
        try {
          sessionStorage.setItem(ALIVE_KEY, String(now));
        } catch { /* storage off */ }
      }
    } else if (d.type === "jserror" && typeof d.text === "string") {
      const e = d as { file?: unknown; line?: unknown; col?: unknown };
      if (typeof e.line !== "number" || !Number.isFinite(e.line) || e.line < 1) return;
      // the script's own URL (sourceURL) → its line; the page's URL (a syntax error) → mapped back
      const built = fromPending ? this.pendingBuilt : this.currentBuilt;
      const jsLine = String(e.file ?? "").endsWith(JS_SOURCE_URL)
        ? e.line
        : scriptLine(built.html, e.line, d.text);
      if (jsLine === null) return;
      const jsCol = typeof e.col === "number" && Number.isFinite(e.col) && e.col > 0 ? e.col : 0;
      // a TypeScript script: the line the room wrote, not the one of the JavaScript that ran
      const at = built.toSource ? built.toSource(jsLine, jsCol) : { line: jsLine, col: jsCol };
      if (!at) return;
      this.on.pageError?.({ line: at.line, col: at.col, text: d.text.slice(0, 500) }, fromPending);
    } else if (d.type === "console" && typeof d.text === "string") {
      // messages of a version that is about to be replaced still count: they are that version's output
      const level = ["log", "info", "warn", "error", "debug"].includes(d.level ?? "") ? d.level : "log";
      const built = fromPending ? this.pendingBuilt : this.currentBuilt;
      const text = built.toSource ? relabel(d.text, built) : d.text;
      this.on.console({ level: level as ConsoleEntry["level"], text: text.slice(0, 4000), at: Date.now() });
    }
  }
}

/** "(JS line 7)" in a console message → the line of the source the room wrote ("(TS line 4)"). */
export function relabel(text: string, built: Built): string {
  return text.replace(/\(JS line (\d+)\)/g, (all, n: string) => {
    const at = built.toSource?.(Number(n), 0);
    return at ? `(${built.label ?? "JS"} line ${at.line})` : all;
  });
}
