// deno-lint-ignore-file no-explicit-any
// End-to-end "go to the code" (owner 2026-11-15: "go to the code when I click on a reference with the usual
// control … cmd click or alt click depending on the keymap"): Ctrl+click on a use goes to its declaration (VS
// Code, JetBrains), the declaration to its next use; a class or an id leads across the three files; the name
// is underlined while the key is held; F12 / Ctrl+B / gd by keyboard; Go back returns; Ctrl+click on nothing
// still adds a cursor; Alt+click in Vim. JavaScript and TypeScript. Soft checks, one report. Local server only.
// Run: deno task build && CHROME_PATH=/path/to/chrome deno test --allow-all e2e/gotodef_test.ts

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
  await sleep(300);
  await p.screenshot({ path: `${SHOTS}/${name}.png` });
}

const ready = (p: Page) =>
  p.waitForFunction(() => (globalThis as any).__livecode?.ready === true, null, { timeout: 20_000 });
const setText = (p: Page, f: F, s: string) =>
  p.evaluate(([f, s]) => (globalThis as any).__livecode.setText(f, s), [f, s] as const);

/** Polled from here (the app's CSP refuses eval inside the page). */
async function expectTrue(p: Page, expr: string, what: string, timeout = 6000) {
  const end = Date.now() + timeout;
  do {
    if (await p.evaluate(expr).catch(() => false)) return;
    await sleep(75);
  } while (Date.now() < end);
  throw new Error(`not true after ${timeout} ms: ${what}`);
}

/** Viewport point inside the `nth` occurrence of `word` in the file's editor (waits for it to be drawn). */
async function wordPoint(p: Page, f: F, word: string, nth = 0): Promise<{ x: number; y: number }> {
  const end = Date.now() + 4000;
  do {
    const pt = await p.evaluate(([f, word, nth]) => {
      let seen = 0;
      // a word may span several highlighted pieces of its line: search the line's whole text
      for (const line of document.querySelectorAll(`#panel-${f} .cm-content .cm-line`)) {
        const text = line.textContent ?? "";
        for (let i = text.indexOf(word as string); i >= 0; i = text.indexOf(word as string, i + 1)) {
          if (seen++ !== nth) continue;
          const mid = i + Math.floor((word as string).length / 2);
          const walk = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
          let off = 0;
          for (let n = walk.nextNode(); n; n = walk.nextNode()) {
            const len = n.textContent!.length;
            if (mid < off + len) {
              const r = document.createRange();
              r.setStart(n, mid - off);
              r.setEnd(n, mid - off + 1);
              const b = r.getBoundingClientRect();
              return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
            }
            off += len;
          }
        }
      }
      return null;
    }, [f, word, nth] as const);
    if (pt) return pt;
    await sleep(100);
  } while (Date.now() < end);
  throw new Error(`"${word}" #${nth} not on screen in ${f}`);
}

/** The file being edited and the caret's place there: "js 1:10". */
const place = `(() => {
  const f = ["html", "css", "js"].find((f) => document.getElementById("tab-" + f).getAttribute("aria-current") === "true");
  const m = /Ln (\\d+), Col (\\d+)/.exec(document.getElementById("sb-pos").textContent);
  return f + " " + m[1] + ":" + m[2];
})()`;
const cursors = (p: Page, f: F) => p.locator(`#panel-${f} .cm-cursorLayer .cm-cursor`).count();
/** The file shows `want` cursors (polled: CodeMirror draws them on its next frame). */
async function expectCursors(p: Page, f: F, want: number, what = "") {
  let got = -1;
  const end = Date.now() + 3000;
  do {
    got = await cursors(p, f);
    if (got === want) return;
    await sleep(75);
  } while (Date.now() < end);
  throw new Error(`${what ? what + ": " : ""}${got} cursors, want ${want}`);
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

const HTML = '<main class="page">\n  <h1 id="title">Hi</h1>\n  <button class="go">Go</button>\n</main>\n';
const CSS = ":root { --gap: 4px }\n.page { padding: var(--gap) }\n#title { margin: 0 }\n";
const JS = "function area(w, h) {\n  return w * h;\n}\n\nconst big = area(2, 3);\n" +
  'document.querySelector(".go").textContent = String(area(big, 1));\n' +
  'document.getElementById("title").hidden = false;\n';

interface Result {
  name: string;
  ok: boolean;
  detail?: string;
}

Deno.test({
  name: "e2e: go to the code — Ctrl+click, across files, keyboard, back, per keymap",
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
      const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
      const a = await ctx.newPage();
      a.on("pageerror", (e) => errors.push(e.message));
      await a.goto(`${base}/r/goto-room`);
      await ready(a);
      // nothing moves under the clicks: no formatting, no refresh while the test reads positions
      await settings(a, { autoFormat: false, autoRun: false });
      await setText(a, "html", HTML);
      await setText(a, "css", CSS);
      await setText(a, "js", JS);

      /** The script shown, the caret parked at its end. */
      const script = async () => {
        await a.click("#tab-js");
        await a.click("#panel-js .cm-content", { position: { x: 3, y: 8 } });
        await a.keyboard.press("Control+End");
      };
      const modClick = async (f: F, word: string, nth: number, mods: ("Control" | "Alt")[]) => {
        const pt = await wordPoint(a, f, word, nth);
        for (const m of mods) await a.keyboard.down(m);
        await a.mouse.move(pt.x, pt.y);
        await a.mouse.click(pt.x, pt.y);
        for (const m of [...mods].reverse()) await a.keyboard.up(m);
      };

      await check("Ctrl+click on a use goes to the declaration (and leaves no extra cursor)", async () => {
        await script();
        await modClick("js", "area", 1, ["Control"]); // `area(2, 3)`
        await expectTrue(a, `${place} === "js 1:10"`, "caret on the function's name");
        await expectCursors(a, "js", 1);
      });

      await check("Ctrl+click on the declaration goes to its next use", async () => {
        await script();
        await modClick("js", "area", 0, ["Control"]);
        await expectTrue(a, `${place} === "js 5:13"`, "caret on the first use");
      });

      await check("the name is underlined while Ctrl is held over it", async () => {
        const pt = await wordPoint(a, "js", "big", 0);
        await a.keyboard.down("Control");
        await a.mouse.move(pt.x - 2, pt.y);
        await a.mouse.move(pt.x, pt.y);
        await expectTrue(
          a,
          `document.querySelector("#panel-js .cm-lc-link")?.textContent === "big"`,
          "underlined",
        );
        await shot(a, "goto-01-link");
        await a.keyboard.up("Control");
        await a.mouse.move(pt.x + 1, pt.y);
        await expectTrue(a, `!document.querySelector("#panel-js .cm-lc-link")`, "gone without the key");
      });

      await check("Ctrl+click where there is nothing to go to still adds a cursor", async () => {
        await script();
        await modClick("js", "return", 0, ["Control"]); // a keyword of area(): leads to area — a jump
        await script();
        await modClick("js", "2, 3", 0, ["Control"]); // a number: nothing
        await sleep(600);
        await expectCursors(a, "js", 2);
        await a.keyboard.press("Escape");
      });

      await check(
        "a class in the script's selector goes to the element in the HTML; Go back returns",
        async () => {
          await script();
          await modClick("js", "go", 0, ["Control"]); // ".go"
          await expectTrue(a, `${place} === "html 3:18"`, "the button's class in index.html");
          await a.keyboard.press("Alt+ArrowLeft"); // VS Code "Go Back"
          await expectTrue(a, `${place}.startsWith("js ")`, "back in the script");
          await modClick("js", "title", 0, ["Control"]); // getElementById("title")
          await expectTrue(a, `${place} === "html 2:11"`, "the h1's id");
        },
      );

      await check(
        "F12: a class of the HTML goes to the stylesheet's rule; var(--gap) to where it is set",
        async () => {
          await a.click("#tab-html");
          const pt = await wordPoint(a, "html", "page", 0);
          await a.mouse.click(pt.x, pt.y);
          await a.keyboard.press("F12");
          await expectTrue(a, `${place} === "css 2:2"`, ".page in style.css");
          const v = await wordPoint(a, "css", "--gap", 1);
          await a.mouse.click(v.x, v.y);
          await a.keyboard.press("F12");
          await expectTrue(a, `${place} === "css 1:9"`, "--gap's declaration");
        },
      );

      await check("the browser's own names say so (no jump)", async () => {
        await script();
        const pt = await wordPoint(a, "js", "document", 0);
        await a.mouse.click(pt.x, pt.y);
        const before = await a.evaluate(place);
        await a.keyboard.press("F12");
        await expectTrue(a, `document.getElementById("live").textContent.includes("browser's own")`, "said");
        if (await a.evaluate(place) !== before) throw new Error("moved");
      });

      await check("TypeScript: a type's use goes to the interface", async () => {
        await a.click("#tab-js");
        await a.click("#ts-toggle");
        await expectTrue(a, `(globalThis).__livecode.scriptLang() === "ts"`, "TypeScript on");
        await setText(
          a,
          "js",
          "interface Point { x: number }\n\nconst p: Point = { x: 1 };\nconsole.log(p.x);\n",
        );
        await script();
        await modClick("js", "Point", 1, ["Control"]);
        await expectTrue(a, `${place} === "js 1:11"`, "the interface");
        await script();
        await modClick("js", "x", 2, ["Control"]); // p.x → the property
        await expectTrue(a, `${place} === "js 1:19"`, "the property");
        await a.click("#ts-toggle");
        await expectTrue(a, `(globalThis).__livecode.scriptLang() === "js"`, "JavaScript again");
        await setText(a, "js", JS);
      });

      await check("JetBrains: Ctrl+click and Ctrl+B", async () => {
        await settings(a, { keymap: "jetbrains" });
        await script();
        await modClick("js", "area", 2, ["Control"]);
        await expectTrue(a, `${place} === "js 1:10"`, "Ctrl+click");
        await script();
        const pt = await wordPoint(a, "js", "big", 1);
        await a.mouse.click(pt.x, pt.y);
        await a.keyboard.press("Control+KeyB");
        await expectTrue(a, `${place} === "js 5:7"`, "Ctrl+B");
      });

      await check(
        "Vim: Alt+click goes there (Ctrl+click adds a cursor, as in Vim's preset), gd by keyboard",
        async () => {
          await settings(a, { keymap: "vim" });
          await script();
          await modClick("js", "area", 1, ["Alt"]);
          await expectTrue(a, `${place} === "js 1:10"`, "Alt+click");
          await script();
          await modClick("js", "area", 1, ["Control"]);
          await sleep(500);
          await expectCursors(a, "js", 2, "Ctrl+click");
          await a.keyboard.press("Escape");
          const pt = await wordPoint(a, "js", "big", 1);
          await a.mouse.click(pt.x, pt.y);
          await a.keyboard.press("Escape");
          await a.keyboard.type("gd");
          await expectTrue(a, `${place} === "js 5:7"`, "gd");
          await settings(a, { keymap: "vscode" });
        },
      );

      await check("no page errors", () => {
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
      throw new Error(`${failed.length} go-to check(s) failed:\n${failed.map((r) => r.name).join("\n")}`);
    }
  },
});
