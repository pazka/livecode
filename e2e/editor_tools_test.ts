// deno-lint-ignore-file no-explicit-any
// End-to-end editor tools, two browsers (A acts, B watches): rename (F2 / Shift+F6 — scope-aware in the
// script, whole words in CSS; one undo step; shared), multiple cursors with the mouse as in each preset
// (VS Code Alt+click / Shift+Alt+drag, JetBrains Alt+Shift+click / Alt+drag, Ctrl+click everywhere), the
// completion icons (letters, never missing-glyph boxes) and the help's Mouse list. Local server only.
// Run: deno task build && CHROME_PATH=/path/to/chrome deno test --allow-all e2e/editor_tools_test.ts

import { type Browser, chromium, type Page } from "playwright-core";
import { loadAssets } from "../src/server/assets.ts";
import { loadConfig } from "../src/server/config.ts";
import { makeHandler } from "../src/server/http.ts";
import { setLogLevel } from "../src/server/log.ts";
import { RoomManager } from "../src/server/rooms.ts";
import { Store } from "../src/server/store.ts";

type F = "html" | "css" | "js";
const CHROME = Deno.env.get("CHROME_PATH") ?? "/usr/bin/google-chrome";
const SHOTS = Deno.env.get("SCREENSHOT_DIR");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function shot(p: Page, name: string) {
  if (!SHOTS) return;
  await Deno.mkdir(SHOTS, { recursive: true });
  await sleep(250);
  await p.screenshot({ path: `${SHOTS}/${name}.png` });
}

const ready = (p: Page) =>
  p.waitForFunction(() => (globalThis as any).__livecode?.ready === true, null, { timeout: 20_000 });
const text = (p: Page, f: F) =>
  p.evaluate((f) => (globalThis as any).__livecode.text(f), f) as Promise<string>;
const setText = (p: Page, f: F, s: string) =>
  p.evaluate(([f, s]) => (globalThis as any).__livecode.setText(f, s), [f, s] as const);

async function expectText(p: Page, f: F, want: string, label = "") {
  let got = "";
  for (let i = 0; i < 50; i++) {
    got = await text(p, f);
    if (got === want) return;
    await sleep(60);
  }
  throw new Error(`${label ? label + ": " : ""}${f} is ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

async function expectTrue(p: Page, expr: string, what: string, timeout = 4000) {
  const end = Date.now() + timeout;
  do {
    if (await p.evaluate(expr).catch(() => false)) return;
    await sleep(60);
  } while (Date.now() < end);
  throw new Error(`not true after ${timeout} ms: ${what}`);
}

async function settings(p: Page, patch: Record<string, unknown>) {
  await p.evaluate((patch) => {
    const k = "livecode.settings.v1";
    const cur = JSON.parse(localStorage.getItem(k) ?? "{}");
    localStorage.setItem(k, JSON.stringify({ ...cur, ...patch }));
  }, patch);
  await p.reload();
  await ready(p);
}

/** The file shown alone, its content, the caret at the start. */
async function reset(p: Page, f: F, content: string) {
  await p.click(`#tab-${f}`);
  await setText(p, f, content);
  await expectText(p, f, content, "reset");
  await p.click(`#panel-${f} .cm-content`, { position: { x: 3, y: 8 } });
  await p.keyboard.press("Control+Home");
  await sleep(50);
}

/** Viewport point of `word` (n-th occurrence) in the file's editor, `at` = fraction of its width. */
async function wordPoint(p: Page, f: F, word: string, nth = 0, at = 0.5) {
  const pt = await p.evaluate(([f, word, nth, at]) => {
    const root = document.querySelector(`#panel-${f} .cm-content`)!;
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let seen = 0;
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      let i = -1;
      while ((i = n.textContent!.indexOf(word as string, i + 1)) >= 0) {
        if (seen++ < (nth as number)) continue;
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + (word as string).length);
        const b = r.getBoundingClientRect();
        return { x: b.left + b.width * (at as number), y: b.top + b.height / 2 };
      }
    }
    return null;
  }, [f, word, nth, at] as const);
  if (!pt) throw new Error(`"${word}" #${nth} not on screen`);
  return pt;
}

interface Result {
  name: string;
  ok: boolean;
  detail?: string;
}

Deno.test({
  name: "e2e: editor tools — rename, multiple cursors by mouse per keymap, completion icons",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
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
    const base = `http://127.0.0.1:${server.addr.port}`;
    const results: Result[] = [];
    const errors: string[] = [];
    const check = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
        results.push({ name, ok: true });
      } catch (e) {
        results.push({
          name,
          ok: false,
          detail: String((e as Error)?.message ?? e).split("\n")[0].slice(0, 300),
        });
      }
    };

    const browser: Browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
    try {
      const page = async (who: string) => {
        const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
        const p = await ctx.newPage();
        p.on("pageerror", (e) => errors.push(`${who}: ${e.message}`));
        p.on("console", (m) => {
          if (m.type() === "error") errors.push(`${who} console: ${m.text()}`);
        });
        return p;
      };
      const a = await page("A");
      const b = await page("B");
      await a.goto(`${base}/new`);
      await a.waitForURL(/\/r\/[a-z2-9]{12}$/);
      await ready(a);
      await b.goto(a.url());
      await ready(b);
      await settings(a, { keymap: "vscode", autoRun: false, theme: "light" });

      const SCOPED =
        "let count = 0;\nfunction add(n) {\n  count += n;\n}\nfunction other() {\n  const count = 1;\n  return count;\n}\n";
      const RENAMED = SCOPED.replace("let count", "let total").replace("  count += n", "  total += n");

      await check("rename (VS Code F2): the script's name, scope-aware, one undo step, shared", async () => {
        await reset(a, "js", SCOPED);
        await a.keyboard.press("ArrowRight");
        await a.keyboard.press("ArrowRight");
        await a.keyboard.press("ArrowRight");
        await a.keyboard.press("ArrowRight"); // caret in "count"
        await a.keyboard.press("F2");
        await a.waitForSelector(".cm-lc-rename input", { timeout: 15_000 }); // the worker loads on first use
        await expectTrue(
          a,
          `document.activeElement === document.querySelector(".cm-lc-rename input")`,
          "box focused",
        );
        await expectTrue(
          a,
          `document.querySelectorAll("#panel-js .cm-lc-renameTarget").length === 2`,
          "2 uses marked",
        );
        await shot(a, "tools-01-rename");
        await a.keyboard.type("total");
        await a.keyboard.press("Enter");
        await expectText(a, "js", RENAMED, "renamed");
        await expectText(b, "js", RENAMED, "B sees it");
        await expectTrue(a, `!document.querySelector(".cm-lc-rename")`, "box closed");
        await a.keyboard.press("Control+z");
        await expectText(a, "js", SCOPED, "one undo step");
      });

      await check("rename: a CSS class, whole words only", async () => {
        await reset(a, "css", ".card { color: red; }\n.card-title { }\n.big.card:hover { }\n");
        await a.keyboard.press("ArrowRight");
        await a.keyboard.press("ArrowRight");
        await a.keyboard.press("F2");
        await a.waitForSelector(".cm-lc-rename input");
        await a.keyboard.type("tile");
        await a.keyboard.press("Enter");
        await expectText(a, "css", ".tile { color: red; }\n.card-title { }\n.big.tile:hover { }\n");
      });

      await check("rename: a name the browser defines is refused with a message", async () => {
        await reset(a, "js", "document.title;\n");
        await a.keyboard.press("ArrowRight");
        await a.keyboard.press("F2");
        await a.waitForSelector(".cm-lc-renameMsg", { timeout: 8000 });
      });

      await check("multi-cursor (VS Code): Alt+click adds a cursor, typing goes to both", async () => {
        await reset(a, "html", "alpha\nbeta\ngamma\n");
        await a.click(`#panel-html .cm-content`, { position: { x: 3, y: 8 } });
        const g = await wordPoint(a, "html", "gamma", 0, 0);
        await a.keyboard.down("Alt");
        await a.mouse.click(g.x + 1, g.y);
        await a.keyboard.up("Alt");
        // CodeMirror draws the new cursor on its next frame: poll, don't read once
        await expectTrue(
          a,
          `document.querySelectorAll("#panel-html .cm-cursorLayer .cm-cursor").length === 2`,
          "2 cursors",
        );
        await a.keyboard.type(">");
        await expectText(a, "html", ">alpha\nbeta\n>gamma\n");
      });

      await check("column (VS Code): Shift+Alt+drag puts one cursor per line", async () => {
        await reset(a, "html", "alpha\nbeta\ngamma\n");
        const s = await wordPoint(a, "html", "alpha", 0, 0);
        const e = await wordPoint(a, "html", "gamma", 0, 0);
        await a.keyboard.down("Shift");
        await a.keyboard.down("Alt");
        await a.mouse.move(s.x + 1, s.y);
        await a.mouse.down();
        await a.mouse.move(e.x + 1, e.y, { steps: 6 });
        await a.mouse.up();
        await a.keyboard.up("Alt");
        await a.keyboard.up("Shift");
        await shot(a, "tools-02-column");
        await a.keyboard.type("- ");
        await expectText(a, "html", "- alpha\n- beta\n- gamma\n");
      });

      await check("multi-cursor: Ctrl+click adds a cursor too", async () => {
        await reset(a, "html", "one\ntwo\n");
        const t = await wordPoint(a, "html", "two", 0, 0);
        await a.keyboard.down("Control");
        await a.mouse.click(t.x + 1, t.y);
        await a.keyboard.up("Control");
        await a.keyboard.type("*");
        await expectText(a, "html", "*one\n*two\n");
      });

      await check("help lists the mouse gestures of the keymap", async () => {
        await a.click("#help-btn");
        await expectTrue(
          a,
          `document.getElementById("help-list").textContent.includes("Alt+Click") && document.getElementById("help-list").textContent.includes("Alt+Shift+Drag")`,
          "Mouse section",
        );
        await a.keyboard.press("Escape");
      });

      await check("completion icons are letters (no □ boxes)", async () => {
        await reset(a, "js", "const c = document.createElement('canvas').getContext('2d')!;\n");
        await a.click("#ts-toggle");
        await a.click("#panel-js .cm-content");
        await a.keyboard.press("Control+End");
        await a.keyboard.type("c.st", { delay: 40 });
        await a.waitForSelector(".cm-tooltip-autocomplete li", { timeout: 15_000 });
        const icons: string[] = await a.evaluate(() =>
          [...document.querySelectorAll(".cm-tooltip-autocomplete .cm-completionIcon")].map((e) =>
            getComputedStyle(e, "::after").content
          )
        );
        await shot(a, "tools-03-icons");
        const bad = icons.filter((c) => !/^"[a-zA-Zƒ]"$/.test(c));
        if (!icons.length || bad.length) throw new Error(`icons ${icons.slice(0, 8)}`);
        if (!icons.includes('"p"') || !icons.includes('"m"')) {
          throw new Error(`no property / method icon: ${icons}`);
        }
        await a.keyboard.press("Escape");
        await setText(a, "js", ""); // TypeScript-only syntax must not run as JavaScript
        await a.click("#ts-toggle");
      });

      await check("completion: Tab the moment the list appears, then typing at once (5 times)", async () => {
        for (let i = 0; i < 5; i++) {
          await reset(a, "html", "");
          await a.keyboard.type("div");
          await a.waitForSelector("#panel-html .cm-tooltip-autocomplete", { timeout: 3000 });
          await a.keyboard.press("Tab"); // within CodeMirror's 75 ms interaction delay
          await a.keyboard.type("in"); // no pause: a deferred accept would miss
          await expectText(a, "html", "<div>in</div>", `try ${i + 1}`);
        }
      });

      await settings(a, { keymap: "jetbrains" });
      await check("JetBrains: Shift+F6 renames; Escape cancels", async () => {
        await reset(a, "js", SCOPED);
        await a.keyboard.press("End");
        await a.keyboard.press("Home");
        for (let i = 0; i < 5; i++) await a.keyboard.press("ArrowRight");
        await a.keyboard.press("Shift+F6");
        await a.waitForSelector(".cm-lc-rename input", { timeout: 10_000 });
        await a.keyboard.type("nope");
        await a.keyboard.press("Escape");
        await expectTrue(a, `!document.querySelector(".cm-lc-rename")`, "closed");
        await expectText(a, "js", SCOPED, "unchanged");
      });

      await check("JetBrains: Alt+Shift+click adds a caret, Alt+drag a column", async () => {
        await reset(a, "html", "alpha\nbeta\ngamma\n");
        const g = await wordPoint(a, "html", "gamma", 0, 0);
        await a.keyboard.down("Alt");
        await a.keyboard.down("Shift");
        await a.mouse.click(g.x + 1, g.y);
        await a.keyboard.up("Shift");
        await a.keyboard.up("Alt");
        await a.keyboard.type("#");
        await expectText(a, "html", "#alpha\nbeta\n#gamma\n");
        // Alt+Shift+click on a caret removes it: typing then goes to the other one only
        const g2 = await wordPoint(a, "html", "#gamma", 0, 1 / 6); // the caret: right after "#"
        await a.keyboard.down("Alt");
        await a.keyboard.down("Shift");
        await a.mouse.click(g2.x, g2.y);
        await a.keyboard.up("Shift");
        await a.keyboard.up("Alt");
        await expectTrue(
          a,
          `document.querySelectorAll("#panel-html .cm-cursorLayer .cm-cursor").length === 1`,
          "one caret after removing the other",
        );
        await a.keyboard.type("!");
        await expectText(a, "html", "#!alpha\nbeta\n#gamma\n", "typing goes to the remaining caret");
        await setText(a, "html", "alpha\nbeta\ngamma\n");
        await expectText(a, "html", "alpha\nbeta\ngamma\n");
        const s = await wordPoint(a, "html", "alpha", 0, 0);
        const e = await wordPoint(a, "html", "gamma", 0, 0);
        await a.keyboard.down("Alt");
        await a.mouse.move(s.x + 1, s.y);
        await a.mouse.down();
        await a.mouse.move(e.x + 1, e.y, { steps: 6 });
        await a.mouse.up();
        await a.keyboard.up("Alt");
        await a.keyboard.type("+");
        await expectText(a, "html", "+alpha\n+beta\n+gamma\n");
      });

      await check("no page errors in either browser", () => {
        const real = [...new Set(errors.filter((e) => !e.includes("favicon")))];
        if (real.length) throw new Error(real.slice(0, 12).join(" | "));
        return Promise.resolve();
      });
    } finally {
      await browser.close();
      await server.shutdown();
      await rooms.close();
    }

    const pass = results.filter((r) => r.ok).length;
    console.log([
      ...results.map((r) => `${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `\n      → ${r.detail}`}`),
      `SUMMARY pass=${pass} fail=${results.length - pass} total=${results.length}`,
    ].join("\n"));
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      throw new Error(`${failed.length} check(s) failed:\n${failed.map((r) => r.name).join("\n")}`);
    }
  },
});
