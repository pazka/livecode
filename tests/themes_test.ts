// Every theme in web/app.css against WCAG 2.2 contrast: text ≥ 4.5:1 (≥ 7:1 in high contrast), focus ring,
// control borders and the text cursor ≥ 3:1. Peer colours: ≥ 3:1 on every background, black label ≥ 4.5:1.

import { assert, assertEquals } from "@std/assert";
import { PEER_COLORS, resolveTheme, THEMES } from "../src/client/themes.ts";

const css = await Deno.readTextFile(new URL("../web/app.css", import.meta.url));

function themeVars(id: string): Record<string, string> {
  const m = css.match(new RegExp(`:root\\[data-theme="${id}"\\]\\s*\\{([^}]*)\\}`));
  assert(m, `theme ${id} missing from app.css`);
  const vars: Record<string, string> = {};
  for (const [, k, v] of m[1].matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})\s*;/gi)) vars[k] = v.toLowerCase();
  return vars;
}

function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const REQUIRED = [
  "bg",
  "line",
  "fg",
  "panel",
  "border",
  "ctl",
  "muted",
  "accent",
  "accent-fg",
  "focus",
  "sel",
  "cursor",
  "danger",
  "ok",
  "warn",
  "tok-keyword",
  "tok-string",
  "tok-number",
  "tok-comment",
  "tok-tag",
  "tok-attr",
  "tok-prop",
  "tok-func",
  "tok-type",
  "tok-op",
  "tok-invalid",
];
const TOKENS = REQUIRED.filter((k) => k.startsWith("tok-"));

for (const t of THEMES) {
  Deno.test(`theme ${t.id}: complete and WCAG contrast`, () => {
    const v = themeVars(t.id);
    for (const k of REQUIRED) assert(v[k], `${t.id}: --${k} missing`);
    const text = t.highContrast ? 7 : 4.5;
    const need: [string, string, string, number][] = [
      ["fg", v.fg, v.bg, text],
      ["fg on panel", v.fg, v.panel, text],
      ["fg on selection", v.fg, v.sel, text],
      ["muted", v.muted, v.bg, text],
      ["muted on panel", v.muted, v.panel, text],
      ["muted on active line", v.muted, v.line, text],
      ["accent text", v["accent-fg"], v.accent, text],
      ["danger", v.danger, v.bg, text],
      ["danger on panel", v.danger, v.panel, text],
      ["ok on panel", v.ok, v.panel, text],
      ["warn on panel", v.warn, v.panel, text],
      ["focus ring", v.focus, v.bg, 3],
      ["focus ring on panel", v.focus, v.panel, 3],
      ["control border", v.ctl, v.bg, 3],
      ["control border on panel", v.ctl, v.panel, 3],
      ["cursor", v.cursor, v.bg, 3],
    ];
    for (const tok of TOKENS) {
      need.push([tok, v[tok], v.bg, text], [`${tok} on active line`, v[tok], v.line, text]);
    }
    const fails = need.filter(([, a, b, n]) => contrast(a, b) < n)
      .map(([name, a, b, n]) => `${name} ${a}/${b} = ${contrast(a, b).toFixed(2)} < ${n}`);
    assertEquals(fails, [], `${t.id}`);
  });
}

/** sRGB mix like CSS color-mix(in srgb, a p, b) — also what alpha compositing over b gives. */
function mix(a: string, b: string, p: number): string {
  const ch = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [ch(a), ch(b)];
  return "#" + x.map((v, i) => Math.round(v * p + y[i] * (1 - p)).toString(16).padStart(2, "0")).join("");
}

for (const t of THEMES.filter((t) => !t.highContrast)) {
  Deno.test(`theme ${t.id}: text on glass stays readable at the brightest backdrop point`, () => {
    // app.css: --app-bg = panel 60 % over bg; backdrop glows = accent 22 %, tok-func 16 %; glass = panel 78 %
    const v = themeVars(t.id);
    const app = mix(v.panel, v.bg, 0.6);
    for (const back of [mix(v.accent, app, 0.22), mix(v["tok-func"], app, 0.16), app]) {
      const glass = mix(v.panel, back, 0.78);
      for (const k of ["fg", "muted"]) {
        const c = contrast(v[k], glass);
        assert(c >= 4.5, `${t.id}: --${k} on glass ${glass} = ${c.toFixed(2)}`);
      }
    }
  });
}

Deno.test("peer colours: visible on every theme, readable black label", () => {
  const bgs = THEMES.flatMap((t) => [themeVars(t.id).bg, themeVars(t.id).line]);
  for (const c of PEER_COLORS) {
    assert(contrast(c, "#000000") >= 4.5, `${c} label`);
    for (const bg of bgs) assert(contrast(c, bg) >= 3, `${c} on ${bg}: ${contrast(c, bg).toFixed(2)}`);
  }
});

Deno.test("theme: system follows the OS (dark, high contrast, forced colours)", () => {
  const q = (on: string[]) => (s: string) => on.includes(s);
  assertEquals(resolveTheme("system", q([])), "light");
  assertEquals(resolveTheme("system", q(["(prefers-color-scheme: dark)"])), "dark");
  assertEquals(resolveTheme("system", q(["(prefers-contrast: more)"])), "hc-light");
  assertEquals(
    resolveTheme("system", q(["(prefers-contrast: more)", "(prefers-color-scheme: dark)"])),
    "hc-dark",
  );
  assertEquals(resolveTheme("system", q(["(forced-colors: active)"])), "hc-light");
  assertEquals(resolveTheme("dim", q([])), "dim");
  assertEquals(resolveTheme("bogus", q([])), "light");
});
