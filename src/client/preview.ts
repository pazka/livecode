// The live preview: debounced ("anti-rebond") refreshes, one fresh sandboxed frame per version (swapped in
// only once it is alive, so the page never flashes blank), console forwarding, and freeze recovery.

export interface ConsoleEntry {
  level: "log" | "info" | "warn" | "error" | "debug";
  text: string;
  at: number;
}

export interface PreviewEvents {
  console(e: ConsoleEntry): void;
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
  private pendingHtml = "";
  private lastHtml: string | null = null;
  private timer: number | undefined;
  private swapTimer: number | undefined;
  private lastAliveWrite = 0;

  constructor(
    private readonly host: HTMLElement,
    private readonly build: () => string,
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
    const html = this.build();
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
    this.pendingHtml = html;
    this.host.appendChild(f);
    clearTimeout(this.swapTimer);
    // a page that never reports alive (it hangs at once, or blocks scripts) is still shown after 1.5 s
    this.swapTimer = setTimeout(() => this.swap(f), 1500);
  }

  private swap(f: HTMLIFrameElement) {
    if (this.pending !== f) return;
    clearTimeout(this.swapTimer);
    this.pending = null;
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
      this.pending!.contentWindow!.postMessage({ __lc: 1, type: "render", html: this.pendingHtml }, "*");
    } else if (d.type === "alive") {
      if (fromPending) this.swap(this.pending!);
      const now = Date.now();
      if (now - this.lastAliveWrite > 1000) {
        this.lastAliveWrite = now;
        try {
          sessionStorage.setItem(ALIVE_KEY, String(now));
        } catch { /* storage off */ }
      }
    } else if (d.type === "console" && typeof d.text === "string") {
      // messages of a version that is about to be replaced still count: they are that version's output
      const level = ["log", "info", "warn", "error", "debug"].includes(d.level ?? "") ? d.level : "log";
      this.on.console({ level: level as ConsoleEntry["level"], text: d.text.slice(0, 4000), at: Date.now() });
    }
  }
}
