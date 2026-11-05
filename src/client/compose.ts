// Builds the preview document from the three files: the runtime first (console capture, errors, heartbeat,
// loop guard — a script, no styles), the CSS in <head>, the JS (loop-guarded) at the end of <body>.
// Raw rendering (owner, X.19): nothing else is added — no doctype, meta, wrapper or CSS of ours. A bare
// fragment is left to the browser exactly like a file with that content would be (no doctype = quirks
// mode, implied html/head/body), so what the preview shows is what a browser tab shows.

import { javascriptLanguage } from "@codemirror/lang-javascript";
import { guardLoops } from "./loopguard.ts";

export interface Sources {
  html: string;
  css: string;
  js: string;
  jsModule: boolean;
}

export const JS_SOURCE_URL = "livecode-script.js";

/** Runs inside the sandboxed preview (opaque origin). Talks to the editor with postMessage only. */
export const RUNTIME = `(() => {
  const post = (m) => { try { parent.postMessage(Object.assign({ __lc: 1 }, m), "*"); } catch (_) {} };
  const fmt = (v, depth) => {
    depth = depth || 0;
    try {
      if (typeof v === "string") return depth ? JSON.stringify(v) : v;
      if (v instanceof Error) return (v.name || "Error") + ": " + v.message;
      if (typeof v === "function") return "ƒ " + (v.name || "anonymous") + "()";
      if (typeof v === "symbol" || typeof v === "bigint") return String(v) + (typeof v === "bigint" ? "n" : "");
      if (v === null || typeof v !== "object") return String(v);
      if (typeof Element !== "undefined" && v instanceof Element) {
        return "<" + v.tagName.toLowerCase() + (v.id ? "#" + v.id : "") +
          (typeof v.className === "string" && v.className ? "." + v.className.trim().split(/\\s+/).join(".") : "") + ">";
      }
      if (depth > 2) return Array.isArray(v) ? "[…]" : "{…}";
      if (Array.isArray(v)) return "[" + v.slice(0, 50).map((x) => fmt(x, depth + 1)).join(", ") + (v.length > 50 ? ", …" : "") + "]";
      const keys = Object.keys(v).slice(0, 30);
      return "{" + keys.map((k) => k + ": " + fmt(v[k], depth + 1)).join(", ") + (Object.keys(v).length > 30 ? ", …" : "") + "}";
    } catch (_) { return "[unprintable]"; }
  };
  const clip = (s) => s.length > 4000 ? s.slice(0, 4000) + "…" : s;
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const orig = console[level] ? console[level].bind(console) : () => {};
    console[level] = (...args) => { post({ type: "console", level, text: clip(args.map((a) => fmt(a)).join(" ")) }); orig(...args); };
  }
  const where = (file, line) => line ? (String(file || "").endsWith("${JS_SOURCE_URL}") ? " (JS line " + line + ")" : " (line " + line + ")") : "";
  addEventListener("error", (e) => {
    if (e.target && e.target !== window && e.target.tagName) {
      post({ type: "console", level: "error", text: "Failed to load " + (e.target.src || e.target.href || e.target.tagName.toLowerCase()) });
      return;
    }
    // a syntax error of the script comes through document.write: drop that wrapper from the message
    const msg = String(e.message || "Error").replace("Failed to execute 'write' on 'Document': ", "");
    post({ type: "console", level: "error", text: clip(msg + where(e.filename, e.lineno)) });
    if (e.lineno) post({ type: "jserror", file: String(e.filename || ""), line: e.lineno, col: e.colno || 0, text: clip(msg.replace(/^Uncaught /, "")) });
  }, true);
  addEventListener("unhandledrejection", (e) => post({ type: "console", level: "error", text: clip("Unhandled promise rejection: " + fmt(e.reason)) }));
  let last = performance.now(), n = 0, tripped = false;
  setInterval(() => { last = performance.now(); tripped = false; post({ type: "alive" }); }, 250);
  post({ type: "alive" });
  window.__lcLoop = (line) => {
    if (tripped) return true;
    if ((++n & 1023) !== 0) return false;
    if (performance.now() - last > 1500) {
      tripped = true;
      post({ type: "console", level: "error", text: "Loop stopped after 1.5 s without a break (JS line " + line + "). Fix the loop condition; the page keeps running." });
      post({ type: "jserror", file: "${JS_SOURCE_URL}", line: line, col: 0, text: "Loop stopped after 1.5 s without a break" });
      return true;
    }
    return false;
  };
})();`;

const escapeScript = (s: string) => s.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
const escapeStyle = (s: string) => s.replace(/<\/style/gi, "<\\/style");

export function composeDocument(src: Sources, opts: { guard?: boolean } = {}): string {
  const guard = opts.guard ?? true;
  let js = src.js;
  if (guard && js.trim()) {
    try {
      js = guardLoops(js);
    } catch { /* unparseable: run as written */ }
  }
  const headBits = `<script>${RUNTIME}</script>` +
    (src.css.trim() ? `<style>${escapeStyle(src.css)}</style>` : "");
  const script = js.trim()
    ? `<script${src.jsModule ? ' type="module"' : ""}>${
      escapeScript(js)
    }\n//# sourceURL=${JS_SOURCE_URL}\n</script>`
    : "";

  let html = src.html;
  const head = html.match(/<head(\s[^>]*)?>/i);
  if (head && head.index !== undefined) {
    const at = head.index + head[0].length;
    html = html.slice(0, at) + headBits + html.slice(at);
  } else {
    const root = html.match(/<html(\s[^>]*)?>/i);
    if (root && root.index !== undefined) {
      const at = root.index + root[0].length;
      html = html.slice(0, at) + `<head>${headBits}</head>` + html.slice(at);
    } else {
      // a fragment (maybe after a doctype): the scripts/styles go first and the parser puts them in the
      // implied <head>, as it would for a file; never before the doctype (that would switch to quirks mode)
      const doctype = html.match(/^\s*<!doctype[^>]*>/i);
      const at = doctype ? doctype[0].length : 0;
      html = html.slice(0, at) + headBits + html.slice(at);
    }
  }
  if (script) {
    const end = html.search(/<\/body\s*>(?![\s\S]*<\/body\s*>)/i);
    html = end >= 0 ? html.slice(0, end) + script + html.slice(end) : html + script;
  }
  return html;
}

/** The user's script inside a composed document: its text and the document line it starts on. */
function scriptOf(html: string): { text: string; firstLine: number } | null {
  const end = html.lastIndexOf(`\n//# sourceURL=${JS_SOURCE_URL}\n</script>`);
  if (end < 0) return null;
  const open = html.lastIndexOf("<script", end);
  const start = html.indexOf(">", open) + 1;
  if (open < 0 || start <= 0) return null;
  return { text: html.slice(start, end), firstLine: html.slice(0, start).split("\n").length };
}

/**
 * The user's script line for an error the page reported against the document (not the script's own URL),
 * or null when it is not the script's. Browsers differ: a line of the whole document, or — for a syntax
 * error that stops the parse before the script's name is read — a line of the script itself (only taken
 * when the script really does not parse, so an error of a <script> in the HTML is never moved here).
 */
export function scriptLine(html: string, docLine: number, message = ""): number | null {
  const s = scriptOf(html);
  if (!s) return null;
  const lines = s.text.split("\n").length;
  const l = docLine - s.firstLine + 1;
  if (l >= 1 && l <= lines) return l;
  if (/SyntaxError/.test(message) && docLine <= lines && !parses(s.text)) return docLine;
  return null;
}

function parses(js: string): boolean {
  let ok = true;
  javascriptLanguage.parser.parse(js).iterate({
    enter: (n) => {
      if (n.type.isError) ok = false;
      return ok;
    },
  });
  return ok;
}
