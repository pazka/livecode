// deno-lint-ignore-file no-explicit-any
// End-to-end autoformat (owner 2026-11-13: "opt out autoformat, on by default, on all files"), two people in
// one room: a moment after A stops typing, the lines A changed are re-indented and trimmed (JS, CSS, HTML),
// at once after a paste; lines A did not touch stay as they are; Undo puts A's text back as typed; two people
// on the same line never get the indentation twice; off (palette or Settings), nothing is formatted.
// Soft checks, one report. Local server only.
// Run: deno task build && CHROME_PATH=/path/to/chrome deno test --allow-all e2e/autoformat_test.ts

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
const hook = (p: Page) => ({
  text: (f: F) => p.evaluate((f) => (globalThis as any).__livecode.text(f), f) as Promise<string>,
  setText: (f: F, s: string) =>
    p.evaluate(([f, s]) => (globalThis as any).__livecode.setText(f, s), [f, s] as const),
});

/** The file's text, polled until it is `want` (or `timeout`). */
async function expectText(p: Page, f: F, want: string, label = "", timeout = 4000) {
  let got = "";
  const end = Date.now() + timeout;
  do {
    got = await hook(p).text(f);
    if (got === want) return;
    await sleep(75);
  } while (Date.now() < end);
  throw new Error(`${label ? label + ": " : ""}${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);
}

/** The file's text stays `want` for `ms` (nothing formats it). */
async function staysText(p: Page, f: F, want: string, ms = 2000) {
  const end = Date.now() + ms;
  do {
    const got = await hook(p).text(f);
    if (got !== want) throw new Error(`changed: ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);
    await sleep(100);
  } while (Date.now() < end);
}

/** The file's content set (as if from the room), its tab shown, the caret at the end of line `line`. */
async function at(p: Page, f: F, content: string, line: number) {
  await p.bringToFront();
  await p.click(`#tab-${f}`);
  await hook(p).setText(f, content);
  await expectText(p, f, content, "reset");
  await caret(p, f, line);
}

/** The caret at the end of line `line` of the file (its tab shown). */
async function caret(p: Page, f: F, line: number) {
  await p.bringToFront();
  await p.click(`#tab-${f}`);
  await p.click(`#panel-${f} .cm-content`, { position: { x: 3, y: 8 } });
  await p.keyboard.press("Control+Home");
  for (let i = 1; i < line; i++) await p.keyboard.press("ArrowDown");
  await p.keyboard.press("End");
}

interface Result {
  name: string;
  ok: boolean;
  detail?: string;
}

Deno.test({
  name: "e2e: autoformat — own lines re-indented and trimmed, paste at once, undo, two people, off",
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
    const watch = (p: Page, who: string) => {
      p.on("pageerror", (e) => errors.push(`${who}: ${e.message}`));
      p.on("console", (m) => {
        if (m.type() === "error") errors.push(`${who} console: ${m.text()}`);
      });
    };

    const browser: Browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
    try {
      const ctxA = await browser.newContext({ viewport: { width: 1360, height: 860 } });
      const ctxB = await browser.newContext({ viewport: { width: 1360, height: 860 } });
      await ctxA.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
      const a = await ctxA.newPage();
      const b = await ctxB.newPage();
      watch(a, "A");
      watch(b, "B");
      await a.goto(`${base}/r/autoformat-room`);
      await ready(a);
      await b.goto(`${base}/r/autoformat-room`);
      await ready(b);

      await check("default: on (Settings → Editor shows it checked)", async () => {
        const box = await a.evaluate(() =>
          (document.getElementById("set-autoformat") as HTMLInputElement).checked
        );
        if (!box) throw new Error("Settings → Editor shows it off");
      });

      await check("JS: the line A typed on is re-indented and trimmed; other lines untouched", async () => {
        await at(a, "js", "if (a) {\nb();\n      c();\n}", 2);
        await a.keyboard.type(" x();   ");
        await a.keyboard.press("ArrowDown"); // leave the line: its trailing spaces may go
        const want = "if (a) {\n  b(); x();\n      c();\n}";
        await expectText(a, "js", want, "A", 3000);
        await expectText(b, "js", want, "B sees it");
        await shot(a, "autoformat-01-js");
      });

      await check("JS: the caret's line keeps the space being typed", async () => {
        await at(a, "js", "if (a) {\nb();\n}", 2);
        await a.keyboard.type(" c ");
        await expectText(a, "js", "if (a) {\n  b(); c \n}", "", 3000);
      });

      await check("CSS and HTML are formatted too", async () => {
        await at(a, "css", "a {\ncolor: red;\n}", 2);
        await a.keyboard.type(" /* ok */");
        await expectText(a, "css", "a {\n  color: red; /* ok */\n}", "CSS", 3000);
        await at(a, "html", "<ul>\n<li>one</li>\n</ul>", 2);
        await a.keyboard.type(" two");
        await a.keyboard.press("ArrowDown");
        await expectText(a, "html", "<ul>\n  <li>one</li> two\n</ul>", "HTML", 3000);
      });

      await check("paste: formatted at once, verbatim <pre> kept", async () => {
        await at(a, "html", "<div>\n</div>", 1);
        await a.evaluate(() => navigator.clipboard.writeText("\n<p>x</p>\n<pre>\n   keep\n</pre>"));
        await a.keyboard.press("Control+KeyV");
        await expectText(a, "html", "<div>\n  <p>x</p>\n  <pre>\n   keep\n</pre>\n</div>", "", 800);
      });

      await check("undo: puts A's text back as typed", async () => {
        await at(a, "js", "if (a) {\nb();\n}", 2);
        await a.keyboard.type(" z();");
        await a.keyboard.press("ArrowDown");
        await expectText(a, "js", "if (a) {\n  b(); z();\n}", "formatted", 3000);
        await a.keyboard.press("Control+KeyZ");
        await expectText(a, "js", "if (a) {\nb(); z();\n}", "undone");
        await staysText(a, "js", "if (a) {\nb(); z();\n}", 1800); // and not formatted again
      });

      await check("two people on one line: indented once, not twice", async () => {
        await at(a, "js", "if (a) {\nb();\n}", 2);
        await expectText(b, "js", "if (a) {\nb();\n}", "B has it");
        await caret(b, "js", 2);
        await caret(a, "js", 2);
        await a.keyboard.type(" p();");
        await b.keyboard.type(" q();");
        await a.bringToFront();
        await sleep(2500);
        const ta = await hook(a).text("js");
        const tb = await hook(b).text("js");
        if (ta !== tb) throw new Error(`A ${JSON.stringify(ta)} / B ${JSON.stringify(tb)}`);
        const line2 = ta.split("\n")[1];
        if (/^\s{3,}/.test(line2) || !line2.includes("p();") || !line2.includes("q();")) {
          throw new Error(JSON.stringify(ta));
        }
      });

      await check("off (palette): nothing is formatted; on again: it is", async () => {
        await a.bringToFront();
        await a.keyboard.press("F1");
        await a.keyboard.type("Format my code as I type");
        await a.keyboard.press("Enter");
        await at(a, "js", "if (a) {\nb();\n}", 2);
        await a.keyboard.type(" y();   ");
        await a.keyboard.press("ArrowDown");
        await staysText(a, "js", "if (a) {\nb(); y();   \n}", 2000);
        const box = await a.evaluate(() =>
          (document.getElementById("set-autoformat") as HTMLInputElement).checked
        );
        if (box) throw new Error("Settings still shows it on");
        await a.keyboard.press("F1");
        await a.keyboard.type("Format my code as I type");
        await a.keyboard.press("Enter");
        await at(a, "js", "if (a) {\nb();\n}", 2);
        await a.keyboard.type(" w();");
        await a.keyboard.press("ArrowDown");
        await expectText(a, "js", "if (a) {\n  b(); w();\n}", "on again", 3000);
      });

      await check("no page errors anywhere", () => {
        // the snippets typed here are not a working page: its ReferenceErrors are the page's, not the app's
        const real = [...new Set(errors.filter((e) => !e.includes("favicon") && !/is not defined/.test(e)))];
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
      throw new Error(
        `${failed.length} autoformat check(s) failed:\n${failed.map((r) => r.name).join("\n")}`,
      );
    }
  },
});
