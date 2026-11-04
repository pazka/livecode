// Builds the preview document from the three files: the runtime first (console capture, errors, heartbeat,
// loop guard), the CSS in <head>, the JS (loop-guarded) at the end of <body>. Works with a full document
// or a bare fragment in the HTML file.

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
    post({ type: "console", level: "error", text: clip((e.message || "Error") + where(e.filename, e.lineno)) });
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
      const doctype = html.match(/^\s*<!doctype[^>]*>/i);
      const rest = doctype ? html.slice(doctype[0].length) : html;
      html = `<!DOCTYPE html><html><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width, initial-scale=1">${headBits}</head><body>${rest}</body></html>`;
    }
  }
  if (script) {
    const end = html.search(/<\/body\s*>(?![\s\S]*<\/body\s*>)/i);
    html = end >= 0 ? html.slice(0, end) + script + html.slice(end) : html + script;
  }
  return html;
}
