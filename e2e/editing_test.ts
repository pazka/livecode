// deno-lint-ignore-file no-explicit-any
// End-to-end editing, two real browsers (A acts, B watches) in one room: selections (own one visible on
// every theme, the other person's one drawn), clipboard, Enter / auto-indent, format, undo/redo, comments,
// the keys that must NOT be swallowed (search field, completion, typed symbols), word / line commands, app
// keys from inside the editor, and the JetBrains, Vim and Emacs keymaps.
//
// Every check is soft: they all run and one report lists each result, so a single run shows the whole state.
// Target: a local server with the built front-end (ci), or a deployed site with LIVECODE_URL (the `live`
// workflow: https://code.hosh.it — it creates one throwaway room, idle-collected after 7 days).
// Uses only DOM + the read-only/setText test hook, so the same file runs against older releases.
// Run: deno task build && CHROME_PATH=/path/to/chrome deno test --allow-all e2e/editing_test.ts

import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";
import { loadAssets } from "../src/server/assets.ts";
import { loadConfig } from "../src/server/config.ts";
import { makeHandler } from "../src/server/http.ts";
import { setLogLevel } from "../src/server/log.ts";
import { RoomManager } from "../src/server/rooms.ts";
import { Store } from "../src/server/store.ts";

type F = "html" | "css" | "js";

const CHROME = Deno.env.get("CHROME_PATH") ?? "/usr/bin/google-chrome";
const LIVE = Deno.env.get("LIVECODE_URL")?.replace(/\/+$/, "");
const SHOTS = Deno.env.get("SCREENSHOT_DIR");
const REPORT = Deno.env.get("REPORT_FILE");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function shot(p: Page, name: string) {
  if (!SHOTS) return;
  await Deno.mkdir(SHOTS, { recursive: true });
  await sleep(250);
  await p.screenshot({ path: `${SHOTS}/${name}.png` });
}

// ---------- page helpers ----------

const hook = (p: Page) => ({
  text: (f: F) => p.evaluate((f) => (globalThis as any).__livecode.text(f), f) as Promise<string>,
  setText: (f: F, s: string) =>
    p.evaluate(([f, s]) => (globalThis as any).__livecode.setText(f, s), [f, s] as const),
});

async function ready(p: Page) {
  await p.waitForFunction(() => (globalThis as any).__livecode?.ready === true, null, { timeout: 20_000 });
}

/** Poll until the file has exactly `want` (or the predicate holds); the error shows what it was. */
async function expectText(p: Page, f: F, want: string | ((s: string) => boolean), label = "") {
  let got = "";
  for (let i = 0; i < 40; i++) {
    got = await hook(p).text(f);
    if (typeof want === "string" ? got === want : want(got)) return;
    await sleep(75);
  }
  throw new Error(
    `${label ? label + ": " : ""}${f} is ${JSON.stringify(got)}` +
      (typeof want === "string" ? `, want ${JSON.stringify(want)}` : ""),
  );
}

async function expectTrue(p: Page, fn: string, what: string, timeout = 3000) {
  try {
    await p.waitForFunction(fn, null, { timeout });
  } catch {
    throw new Error(`not true after ${timeout} ms: ${what}`);
  }
}

/** Clean slate: dialogs closed, search panel closed, the file's content, the tab shown, caret at the start. */
async function reset(p: Page, f: F, content: string) {
  await p.bringToFront();
  await p.evaluate(() => document.querySelectorAll("dialog[open]").forEach((d) => (d as HTMLDialogElement).close()));
  const close = p.locator(`#panel-${f} .cm-search button[name=close]`);
  if (await close.count()) await close.first().click();
  await p.click(`#tab-${f}`);
  await hook(p).setText(f, content);
  await expectText(p, f, content, "reset");
  await p.click(`#panel-${f} .cm-content`, { position: { x: 3, y: 8 } });
  await p.keyboard.press("Control+Home");
  await sleep(60);
}

/** Viewport point at the middle of the first occurrence of `word` in the file's editor. */
async function wordPoint(p: Page, f: F, word: string, at = 0.5): Promise<{ x: number; y: number }> {
  const pt = await p.evaluate(([f, word, at]) => {
    const root = document.querySelector(`#panel-${f} .cm-content`)!;
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const i = n.textContent!.indexOf(word as string);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + (word as string).length);
      const b = r.getBoundingClientRect();
      return { x: b.left + b.width * (at as number), y: b.top + b.height / 2 };
    }
    return null;
  }, [f, word, at] as const);
  if (!pt) throw new Error(`"${word}" not on screen in ${f}`);
  return pt;
}

/**
 * Is my selection actually visible? CodeMirror draws it in a layer BEHIND the text; anything opaque between
 * that layer and the eye (a line background …) hides it. Hit-test the middle of every selection rectangle.
 */
async function ownSelection(p: Page, f: F): Promise<{ rects: number; hidden: number }> {
  return await p.evaluate((f) => {
    const panel = document.getElementById(`panel-${f}`)!;
    const scroller = panel.querySelector(".cm-scroller")!;
    const alpha = (c: string) => {
      if (c === "transparent") return 0;
      const slash = c.match(/\/\s*([\d.]+)(%?)\s*\)$/);
      if (slash) return parseFloat(slash[1]) / (slash[2] ? 100 : 1);
      const rgba = c.match(/^rgba\(([^)]+)\)$/);
      if (rgba) return parseFloat(rgba[1].split(",")[3]);
      return 1;
    };
    let rects = 0, hidden = 0;
    for (const el of panel.querySelectorAll(".cm-selectionBackground")) {
      const r = el.getBoundingClientRect();
      if (r.width < 3 || r.height < 3) continue;
      rects++;
      const stack = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      for (const e of stack) {
        if (e === scroller || !scroller.contains(e)) break;
        if (alpha(getComputedStyle(e).backgroundColor) > 0.5) {
          hidden++;
          break;
        }
      }
    }
    return { rects, hidden };
  }, f);
}

async function expectOwnSelectionVisible(p: Page, f: F) {
  const s = await ownSelection(p, f);
  if (s.rects === 0) throw new Error("no selection drawn at all");
  if (s.hidden) throw new Error(`${s.hidden} of ${s.rects} selection rectangle(s) painted over (invisible)`);
}

/** What B sees of A's selection (y-codemirror marks). */
async function remoteSelectionText(p: Page, f: F): Promise<string> {
  return await p.evaluate((f) =>
    [...document.querySelectorAll(`#panel-${f} .cm-ySelection`)].map((e) => e.textContent).join(""), f);
}

async function expectRemoteSelection(p: Page, f: F, includes: string) {
  let got = "";
  for (let i = 0; i < 40; i++) {
    got = await remoteSelectionText(p, f);
    if (got.includes(includes)) return;
    await sleep(75);
  }
  throw new Error(`peer sees selection ${JSON.stringify(got)}, want it to include ${JSON.stringify(includes)}`);
}

const cursors = (p: Page, f: F) => p.locator(`#panel-${f} .cm-cursorLayer .cm-cursor`).count();

async function setSettings(p: Page, patch: Record<string, unknown>) {
  await p.evaluate((patch) => {
    const k = "livecode.settings.v1";
    const cur = JSON.parse(localStorage.getItem(k) ?? "{}");
    localStorage.setItem(k, JSON.stringify({ ...cur, ...patch }));
  }, patch);
  await p.reload();
  await ready(p);
}

// ---------- the test ----------

interface Result {
  name: string;
  ok: boolean;
  detail?: string;
}

Deno.test({
  name: "e2e: editing — selections, clipboard, Enter, format, keys not swallowed, keymaps",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    let base = LIVE ?? "";
    let stop = async () => {};
    if (!LIVE) {
      setLogLevel("error");
      const dataDir = await Deno.makeTempDir();
      const env: Record<string, string> = { APP_DATA_DIR: dataDir, APP_BASE_URL: "http://127.0.0.1" };
      const cfg = loadConfig((k) => env[k]);
      const store = new Store(dataDir);
      await store.init();
      const rooms = new RoomManager(store, cfg.limits, 200);
      const server = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen() {} },
        makeHandler({ cfg, rooms, assets: loadAssets() }),
      );
      base = `http://127.0.0.1:${server.addr.port}`;
      stop = async () => {
        await server.shutdown();
        await rooms.close();
      };
    }

    const results: Result[] = [];
    const errors: string[] = [];
    const check = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
        results.push({ name, ok: true });
      } catch (e) {
        results.push({ name, ok: false, detail: String((e as Error)?.message ?? e).split("\n")[0].slice(0, 300) });
      }
    };

    const browser: Browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
    let roomUrl = "";
    let a: Page | null = null;
    try {
      const mk = async (who: string): Promise<[BrowserContext, Page]> => {
        const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
        await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
        const p = await ctx.newPage();
        p.on("pageerror", (e) => errors.push(`${who}: ${e.message}`));
        p.on("console", (m) => {
          if (m.type() === "error") errors.push(`${who} console: ${m.text()}`);
        });
        return [ctx, p];
      };
      const [, pa] = await mk("A");
      const [, b] = await mk("B");
      a = pa;
      await a.goto(`${base}/new`);
      await a.waitForURL(/\/r\/[a-z2-9]{12}$/);
      roomUrl = a.url();
      await ready(a);
      await b.goto(roomUrl);
      await ready(b);
      await a.waitForFunction(() => (globalThis as any).__livecode.peers() === 2);
      // pin both to light + VS Code keys; B stays on the HTML tab and watches
      await setSettings(a, { theme: "light", keymap: "vscode" });
      await setSettings(b, { theme: "light", keymap: "vscode" });
      await a.waitForFunction(() => (globalThis as any).__livecode.peers() === 2);

      const PAGE = "<main>\n<h1>Hello world</h1>\n<p>alpha beta gamma</p>\n</main>";

      // ----- selections -----
      await check("selection: double-click a word — visible to me (light)", async () => {
        await reset(a!, "html", PAGE);
        const pt = await wordPoint(a!, "html", "beta");
        await a!.mouse.dblclick(pt.x, pt.y);
        await shot(a!, "sel-01-me-word");
        await expectOwnSelectionVisible(a!, "html");
      });
      await check("selection: the other person sees my selected word", async () => {
        await expectRemoteSelection(b, "html", "beta");
        await shot(b, "sel-02-peer-word");
      });
      await check("selection: mouse drag across words — visible to me", async () => {
        const s = await wordPoint(a!, "html", "alpha", 0);
        const e = await wordPoint(a!, "html", "gamma", 1);
        await a!.mouse.move(s.x + 1, s.y);
        await a!.mouse.down();
        await a!.mouse.move((s.x + e.x) / 2, s.y, { steps: 4 });
        await a!.mouse.move(e.x - 1, e.y, { steps: 4 });
        await a!.mouse.up();
        await expectOwnSelectionVisible(a!, "html");
        await expectRemoteSelection(b, "html", "alpha beta gamm");
      });
      await check("selection: Shift+End on one line — visible to me", async () => {
        await reset(a!, "html", PAGE);
        await a!.keyboard.press("ArrowDown");
        await a!.keyboard.press("Shift+End");
        await expectOwnSelectionVisible(a!, "html");
      });
      await check("selection: Shift+ArrowDown over several lines — visible to me and to the peer", async () => {
        await reset(a!, "html", PAGE);
        await a!.keyboard.press("ArrowDown");
        await a!.keyboard.press("Shift+ArrowDown");
        await a!.keyboard.press("Shift+ArrowDown");
        await a!.keyboard.press("Shift+End");
        await shot(a!, "sel-03-me-lines");
        await expectOwnSelectionVisible(a!, "html");
        await expectRemoteSelection(b, "html", "Hello world");
        await shot(b, "sel-04-peer-lines");
      });
      await check("selection: Ctrl+A — visible to me", async () => {
        await reset(a!, "html", PAGE);
        await a!.keyboard.press("Control+KeyA");
        await expectOwnSelectionVisible(a!, "html");
      });
      for (const theme of ["dark", "dim", "sepia", "solarized-light", "solarized-dark", "hc-dark", "hc-light"]) {
        await check(`selection: visible to me on theme ${theme}`, async () => {
          await a!.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
          await reset(a!, "html", PAGE);
          const pt = await wordPoint(a!, "html", "beta");
          await a!.mouse.dblclick(pt.x, pt.y);
          if (theme === "dark" || theme === "hc-dark") await shot(a!, `sel-05-me-${theme}`);
          await expectOwnSelectionVisible(a!, "html");
        });
      }
      await a.evaluate(() => (document.documentElement.dataset.theme = "light"));

      // ----- clipboard -----
      await check("clipboard: Ctrl+C / Ctrl+V a word", async () => {
        await reset(a!, "html", "alpha beta");
        const pt = await wordPoint(a!, "html", "alpha");
        await a!.mouse.dblclick(pt.x, pt.y);
        await a!.keyboard.press("Control+KeyC");
        await a!.keyboard.press("End");
        await a!.keyboard.type(" ");
        await a!.keyboard.press("Control+KeyV");
        await expectText(a!, "html", "alpha beta alpha");
        await expectText(b, "html", "alpha beta alpha", "peer");
      });
      await check("clipboard: Ctrl+X cuts, Ctrl+V pastes elsewhere", async () => {
        await reset(a!, "html", "one two three");
        const pt = await wordPoint(a!, "html", "three");
        await a!.mouse.dblclick(pt.x, pt.y);
        await a!.keyboard.press("Control+KeyX");
        await expectText(a!, "html", "one two ");
        await a!.keyboard.press("Control+Home");
        await a!.keyboard.press("Control+KeyV");
        await expectText(a!, "html", "threeone two ");
      });
      await check("clipboard: Ctrl+C with no selection copies the line (paste duplicates it)", async () => {
        await reset(a!, "html", "first\nsecond");
        await a!.keyboard.press("Control+KeyC");
        await a!.keyboard.press("Control+KeyV");
        await expectText(a!, "html", "first\nfirst\nsecond");
      });

      // ----- Enter / auto-indent -----
      await check("Enter: between <div></div> opens an indented line", async () => {
        await reset(a!, "html", "");
        await a!.keyboard.type("<div>");
        await expectText(a!, "html", "<div></div>", "autoclose");
        await a!.keyboard.press("Enter");
        await a!.keyboard.type("hi");
        await expectText(a!, "html", "<div>\n  hi\n</div>");
      });
      await check("Enter: inside CSS braces indents", async () => {
        await reset(a!, "css", "");
        await a!.keyboard.type("body {");
        await a!.keyboard.press("Enter");
        await a!.keyboard.type("color: red;");
        await expectText(a!, "css", "body {\n  color: red;\n}");
      });
      await check("Enter: inside a JS block indents, Enter after a statement keeps the indent", async () => {
        await reset(a!, "js", "");
        await a!.keyboard.type("if (x) {");
        await a!.keyboard.press("Enter");
        await a!.keyboard.type("a();");
        await a!.keyboard.press("Enter");
        await a!.keyboard.type("b();");
        await expectText(a!, "js", "if (x) {\n  a();\n  b();\n}");
      });

      // ----- format -----
      const MESSY_JS = "function f() {\nif (x) {\n      return 1;   \n}\n}";
      const NEAT_JS = "function f() {\n  if (x) {\n    return 1;\n  }\n}";
      await check("format: Shift+Alt+F (VS Code) formats the whole JS file without a selection", async () => {
        await reset(a!, "js", MESSY_JS);
        await a!.keyboard.press("Shift+Alt+KeyF");
        await expectText(a!, "js", NEAT_JS);
      });
      await check("format: Shift+Alt+F formats CSS", async () => {
        await reset(a!, "css", "body {\ncolor: red;  \n    margin: 0;\n}");
        await a!.keyboard.press("Shift+Alt+KeyF");
        await expectText(a!, "css", "body {\n  color: red;\n  margin: 0;\n}");
      });
      await check("format: Shift+Alt+F formats HTML", async () => {
        await reset(a!, "html", "<main>\n<p>x</p>\n      <p>y</p>\n</main>");
        await a!.keyboard.press("Shift+Alt+KeyF");
        await expectText(a!, "html", "<main>\n  <p>x</p>\n  <p>y</p>\n</main>");
      });

      // ----- undo / redo / comments -----
      await check("undo/redo: Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y", async () => {
        await reset(a!, "js", "");
        await a!.keyboard.type("abc");
        await expectText(a!, "js", "abc");
        await a!.keyboard.press("Control+KeyZ");
        await expectText(a!, "js", "");
        await a!.keyboard.press("Control+Shift+KeyZ");
        await expectText(a!, "js", "abc");
        await a!.keyboard.press("Control+KeyZ");
        await a!.keyboard.press("Control+KeyY");
        await expectText(a!, "js", "abc");
      });
      await check("undo: Ctrl+Z only undoes my edits, not the peer's", async () => {
        await reset(a!, "js", "");
        await a!.keyboard.type("mine");
        await expectText(b, "js", "mine", "peer");
        await b.evaluate(() => {
          const lc = (globalThis as any).__livecode;
          lc.setText("js", lc.text("js") + "\n// theirs");
        });
        await expectText(a!, "js", "mine\n// theirs");
        await a!.bringToFront();
        await a!.keyboard.press("Control+KeyZ");
        await expectText(a!, "js", "\n// theirs");
      });
      for (
        const [f, src, want] of [
          ["js", "let a = 1;", "// let a = 1;"],
          ["css", "a { color: red; }", "/* a { color: red; } */"],
          ["html", "<p>x</p>", "<!-- <p>x</p> -->"],
        ] as [F, string, string][]
      ) {
        await check(`comment: Ctrl+/ in ${f}`, async () => {
          await reset(a!, f, src);
          await a!.keyboard.press("Control+Slash");
          await expectText(a!, f, want);
        });
      }

      // ----- keys that must not be swallowed -----
      await check("search field: Ctrl+A selects the field text (not the editor), typing replaces it", async () => {
        await reset(a!, "html", PAGE);
        const pt = await wordPoint(a!, "html", "beta");
        await a!.mouse.dblclick(pt.x, pt.y);
        await a!.keyboard.press("Control+KeyF");
        await a!.waitForSelector("#panel-html .cm-search input[name=search]");
        await a!.keyboard.press("Control+KeyA");
        await a!.keyboard.type("gamma");
        const v = await a!.inputValue("#panel-html .cm-search input[name=search]");
        if (v !== "gamma") throw new Error(`search field is ${JSON.stringify(v)}, want "gamma"`);
        await expectText(a!, "html", PAGE, "editor untouched");
      });
      await check("search field: Ctrl+Z / Backspace edit the field, the editor is untouched", async () => {
        await a!.keyboard.press("Backspace");
        await a!.keyboard.press("Control+KeyZ");
        await expectText(a!, "html", PAGE, "editor untouched");
      });
      await check("search field: Escape closes the search panel (with a selection in the editor)", async () => {
        await a!.keyboard.press("Escape");
        await expectTrue(a!, `!document.querySelector("#panel-html .cm-search")`, "search panel closed");
      });
      await check("completion: Escape closes the popup and keeps my 2 cursors", async () => {
        await reset(a!, "js", "foo\nfoo");
        await a!.keyboard.press("Control+KeyD");
        await a!.keyboard.press("Control+KeyD");
        await a!.keyboard.type("fun");
        await a!.waitForSelector("#panel-js .cm-tooltip-autocomplete", { timeout: 3000 });
        await a!.keyboard.press("Escape");
        await expectTrue(a!, `!document.querySelector("#panel-js .cm-tooltip-autocomplete")`, "popup closed");
        const n = await cursors(a!, "js");
        if (n !== 2) throw new Error(`${n} cursor(s) after Escape, want 2`);
        await a!.keyboard.type("X");
        await expectText(a!, "js", "funX\nfunX");
      });
      await check("completion: Enter accepts the suggestion", async () => {
        await reset(a!, "js", "const longName = 1;\n");
        await a!.keyboard.press("Control+End");
        await a!.keyboard.type("longN");
        await a!.waitForSelector("#panel-js .cm-tooltip-autocomplete", { timeout: 3000 });
        await a!.keyboard.press("Enter");
        await expectText(a!, "js", "const longName = 1;\nlongName");
      });
      await check("typing: every ASCII symbol reaches the editor", async () => {
        await reset(a!, "js", "");
        const bad: string[] = [];
        for (const c of "[]{}()<>@#~\\|^$%&*_+=-;:,.?!/'\"`") {
          await a!.keyboard.press("Control+KeyA");
          await a!.keyboard.press("Backspace");
          await a!.keyboard.type(c);
          const t = await hook(a!).text("js");
          if (!t.startsWith(c)) bad.push(`${c}→${JSON.stringify(t)}`);
        }
        if (bad.length) throw new Error(`swallowed/changed: ${bad.join(" ")}`);
      });
      await check("palette: typing in its field is not taken as shortcuts; Escape returns to the editor", async () => {
        await reset(a!, "html", PAGE);
        await a!.keyboard.press("F1");
        await a!.waitForSelector("#palette[open]");
        await a!.keyboard.type("dz[]1");
        const v = await a!.inputValue("#palette-input");
        if (v !== "dz[]1") throw new Error(`palette field is ${JSON.stringify(v)}`);
        await a!.keyboard.press("Escape");
        await expectTrue(a!, `!document.querySelector("#palette[open]")`, "palette closed");
        await expectTrue(
          a!,
          `!!document.activeElement?.closest("#panel-html .cm-content")`,
          "focus back in the editor",
        );
      });

      // ----- word / line commands (VS Code) -----
      await check("words: Ctrl+→ jumps a word, Ctrl+Shift+→ selects one", async () => {
        await reset(a!, "html", "alpha beta gamma");
        await a!.keyboard.press("Control+ArrowRight");
        await a!.keyboard.press("Control+Shift+ArrowRight");
        await a!.keyboard.type("X");
        await expectText(a!, "html", "alphaX gamma");
      });
      await check("lines: Alt+↓ moves, Shift+Alt+↓ duplicates, Ctrl+Shift+K deletes", async () => {
        await reset(a!, "js", "one\ntwo\nthree");
        await a!.keyboard.press("Alt+ArrowDown");
        await expectText(a!, "js", "two\none\nthree", "move");
        await a!.keyboard.press("Shift+Alt+ArrowDown");
        await expectText(a!, "js", "two\none\none\nthree", "duplicate");
        await a!.keyboard.press("Control+Shift+KeyK");
        await expectText(a!, "js", "two\none\nthree", "delete");
      });
      await check("lines: Tab indents the line, Shift+Tab outdents", async () => {
        await reset(a!, "js", "one");
        await a!.keyboard.press("Tab");
        await expectText(a!, "js", "  one");
        await a!.keyboard.press("Shift+Tab");
        await expectText(a!, "js", "one");
      });
      await check("multi-cursor: Ctrl+D twice then type replaces both", async () => {
        await reset(a!, "js", "foo bar foo");
        await a!.keyboard.press("Control+KeyD");
        await a!.keyboard.press("Control+KeyD");
        await a!.keyboard.type("X");
        await expectText(a!, "js", "X bar X");
      });

      // ----- app keys from inside the editor -----
      await check("app keys in the editor: Alt+2 / Alt+3 / Alt+1 switch files", async () => {
        await reset(a!, "html", PAGE);
        await a!.keyboard.press("Alt+Digit2");
        await expectTrue(a!, `document.querySelector("#tab-css").getAttribute("aria-selected") === "true"`, "CSS");
        await a!.keyboard.press("Alt+Digit3");
        await expectTrue(a!, `document.querySelector("#tab-js").getAttribute("aria-selected") === "true"`, "JS");
        await a!.keyboard.press("Alt+Digit1");
        await expectTrue(a!, `document.querySelector("#tab-html").getAttribute("aria-selected") === "true"`, "HTML");
      });
      await check("app keys in the editor: Ctrl+Enter runs the preview", async () => {
        await reset(a!, "html", PAGE);
        const n = await a!.evaluate(() => (globalThis as any).__livecode.renders());
        await a!.keyboard.press("Control+Enter");
        await expectTrue(a!, `globalThis.__livecode.renders() > ${n}`, "a new render");
        await expectText(a!, "html", PAGE, "no newline typed");
      });

      // ----- JetBrains -----
      await setSettings(a, { keymap: "jetbrains" });
      await check("JetBrains: Ctrl+D duplicates, Ctrl+Y deletes the line", async () => {
        await reset(a!, "js", "one\ntwo");
        await a!.keyboard.press("Control+KeyD");
        await expectText(a!, "js", "one\none\ntwo", "duplicate");
        await a!.keyboard.press("Control+KeyY");
        await expectText(a!, "js", "one\ntwo", "delete");
      });
      await check("JetBrains: Alt+Shift+↓ moves the line, Shift+Enter opens a line below", async () => {
        await reset(a!, "js", "one\ntwo");
        await a!.keyboard.press("Alt+Shift+ArrowDown");
        await expectText(a!, "js", "two\none", "move");
        await a!.keyboard.press("Shift+Enter");
        await a!.keyboard.type("x");
        await expectText(a!, "js", "two\none\nx", "line below");
      });
      await check("JetBrains: Ctrl+Alt+L reformats the whole file", async () => {
        await reset(a!, "js", MESSY_JS);
        await a!.keyboard.press("Control+Alt+KeyL");
        await expectText(a!, "js", NEAT_JS);
      });
      await check("JetBrains: Alt+J twice selects 2 occurrences", async () => {
        await reset(a!, "js", "foo bar foo");
        await a!.keyboard.press("Alt+KeyJ");
        await a!.keyboard.press("Alt+KeyJ");
        await a!.keyboard.type("X");
        await expectText(a!, "js", "X bar X");
      });
      await check("JetBrains: double-click selection is visible", async () => {
        await reset(a!, "html", PAGE);
        const pt = await wordPoint(a!, "html", "beta");
        await a!.mouse.dblclick(pt.x, pt.y);
        await expectOwnSelectionVisible(a!, "html");
      });

      // ----- Vim -----
      await setSettings(a, { keymap: "vim" });
      await check("Vim: v e selects a word visibly, the peer sees it", async () => {
        await reset(a!, "html", "alpha beta gamma\nsecond line");
        await a!.keyboard.press("Escape");
        await a!.keyboard.type("gg0ve");
        await shot(a!, "sel-06-vim-visual");
        await expectOwnSelectionVisible(a!, "html");
        await expectRemoteSelection(b, "html", "alpha");
      });
      await check("Vim: y $ p yanks and puts", async () => {
        await a!.keyboard.type("y$p");
        await expectText(a!, "html", "alpha beta gammaalpha\nsecond line");
      });
      await check("Vim: u undoes, dd deletes a line", async () => {
        await a!.keyboard.type("u");
        await expectText(a!, "html", "alpha beta gamma\nsecond line", "undo");
        await a!.keyboard.type("ggdd");
        await expectText(a!, "html", "second line", "dd");
      });
      await check("Vim: gg=G reindents the file", async () => {
        await reset(a!, "js", MESSY_JS.replace("   \n", "\n"));
        await a!.keyboard.press("Escape");
        await a!.keyboard.type("gg=G");
        await expectText(a!, "js", NEAT_JS);
      });
      await check("Vim: i inserts, Escape leaves insert mode", async () => {
        await reset(a!, "js", "abc");
        await a!.keyboard.press("Escape");
        await a!.keyboard.type("0iZ");
        await a!.keyboard.press("Escape");
        await a!.keyboard.type("x"); // normal mode: deletes the char under the cursor (Z)
        await expectText(a!, "js", "abc");
      });

      // ----- Emacs -----
      await setSettings(a, { keymap: "emacs" });
      await check("Emacs: Ctrl+E / Ctrl+A move to line end / start (Ctrl+A is not select-all)", async () => {
        await reset(a!, "html", "alpha beta\ngamma");
        await a!.keyboard.press("Control+KeyE");
        await a!.keyboard.type("!");
        await a!.keyboard.press("Control+KeyA");
        await a!.keyboard.type("^");
        await expectText(a!, "html", "^alpha beta!\ngamma");
      });
      await check("Emacs: Ctrl+Space mark + Ctrl+F selects visibly; Ctrl+W kills, Ctrl+Y yanks", async () => {
        await reset(a!, "html", "alpha beta");
        await a!.keyboard.press("Control+Space");
        for (let i = 0; i < 5; i++) await a!.keyboard.press("Control+KeyF");
        await expectOwnSelectionVisible(a!, "html");
        await a!.keyboard.press("Control+KeyW");
        await expectText(a!, "html", " beta", "kill");
        await a!.keyboard.press("Control+KeyE");
        await a!.keyboard.press("Control+KeyY");
        await expectText(a!, "html", " betaalpha", "yank");
      });
      await check("Emacs: Alt+X opens the command palette", async () => {
        await a!.keyboard.press("Alt+KeyX");
        await a!.waitForSelector("#palette[open]", { timeout: 3000 });
        await a!.keyboard.press("Escape");
      });

      await check("no page errors in either browser", async () => {
        const real = errors.filter((e) => !e.includes("favicon"));
        if (real.length) throw new Error(real.slice(0, 5).join(" | "));
      });
    } finally {
      try {
        if (a && roomUrl) {
          for (const f of ["html", "css", "js"] as F[]) await hook(a).setText(f, "");
        }
      } catch { /* best effort: leave the throwaway room empty */ }
      await browser.close();
      await stop();
    }

    const pass = results.filter((r) => r.ok).length;
    const lines = [
      `target: ${LIVE ?? "local server"}  room: ${roomUrl}`,
      ...results.map((r) => `${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `\n      → ${r.detail}`}`),
      `SUMMARY pass=${pass} fail=${results.length - pass} total=${results.length}`,
    ];
    console.log(lines.join("\n"));
    if (REPORT) {
      await Deno.mkdir(REPORT.replace(/\/[^/]*$/, ""), { recursive: true });
      await Deno.writeTextFile(REPORT, lines.join("\n") + "\n");
    }
    const failed = results.filter((r) => !r.ok);
    if (failed.length) throw new Error(`${failed.length} editing check(s) failed:\n${failed.map((r) => r.name).join("\n")}`);
  },
});
