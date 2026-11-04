// deno-lint-ignore-file no-explicit-any
// End-to-end, two real browsers in one room (headless Chromium driven by playwright-core) against the real
// server with the real built front-end: shared edits, the live preview refresh, remote cursors, themes,
// keymaps, the command palette by keyboard, and the infinite-loop guard.
// Run: deno task build && CHROME_PATH=/path/to/chrome deno task e2e

import { assert, assertEquals } from "@std/assert";
import { chromium, type Frame, type Page } from "playwright-core";
import { loadAssets } from "../src/server/assets.ts";
import { loadConfig } from "../src/server/config.ts";
import { makeHandler } from "../src/server/http.ts";
import { setLogLevel } from "../src/server/log.ts";
import { RoomManager } from "../src/server/rooms.ts";
import { Store } from "../src/server/store.ts";

const CHROME = Deno.env.get("CHROME_PATH") ?? "/usr/bin/google-chrome";

async function previewFrame(page: Page): Promise<Frame> {
  // the visible frame is the one without the "pending" class
  const handle = await page.waitForSelector("iframe.preview-frame:not(.pending)", { timeout: 15_000 });
  const f = await handle.contentFrame();
  assert(f, "preview frame");
  return f;
}

async function previewText(page: Page, selector: string): Promise<string> {
  const f = await previewFrame(page);
  return (await f.locator(selector).first().textContent({ timeout: 5_000 })) ?? "";
}

Deno.test({
  name: "e2e: two people, one room — edit, live preview, cursors, themes, keymaps, palette, loop guard",
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
    const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
    const errors: string[] = [];
    try {
      const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const a = await ctxA.newPage();
      const b = await ctxB.newPage();
      for (const [p, who] of [[a, "A"], [b, "B"]] as const) {
        p.on("pageerror", (e) => errors.push(`${who}: ${e.message}`));
        p.on("console", (m) => {
          if (m.type() === "error") errors.push(`${who} console: ${m.text()}`);
        });
      }

      // landing → new room
      await a.goto(`${base}/`);
      await a.click("#new-room");
      await a.waitForURL(/\/r\/[a-z2-9]{12}$/);
      const roomUrl = a.url();
      await b.goto(roomUrl);
      for (const p of [a, b]) await p.waitForFunction(() => (globalThis as any).__livecode?.ready === true);

      // both see the starter and each other
      assert((await a.evaluate(() => (globalThis as any).__livecode.text("html"))).includes("<h1>"));
      await a.waitForFunction(() => (globalThis as any).__livecode.peers() === 2);
      assertEquals(await b.locator("#peers li").count(), 2);
      assertEquals(await previewText(a, "h1"), "Hello, live code!");

      // A edits; B's preview refreshes by itself (debounced)
      await a.evaluate(() =>
        (globalThis as any).__livecode.setText(
          "html",
          '<h1 id="t">Hello from A</h1><button id="btn">b</button><p id="out"></p>',
        )
      );
      await b.waitForFunction(() => (globalThis as any).__livecode.text("html").includes("Hello from A"));
      await b.waitForFunction(
        () => {
          const f = document.querySelector<HTMLIFrameElement>("iframe.preview-frame:not(.pending)");
          return f !== null && (globalThis as any).__livecode.renders() >= 2;
        },
        null,
        { timeout: 10_000 },
      );
      assertEquals(await previewText(b, "#t"), "Hello from A");

      // typing for real in A's editor, B sees it; A's cursor shows up in B's editor with A's name
      await a.click("#panel-html .cm-content");
      await a.keyboard.press("Control+End");
      await a.keyboard.type('\n<p id="typed">typed');
      await b.waitForFunction(() =>
        (globalThis as any).__livecode.text("html").includes('<p id="typed">typed')
      );
      await b.waitForSelector("#panel-html .cm-ySelectionCaret", { timeout: 5_000 });

      // the JS file runs in the preview; console output reaches the console panel
      await b.evaluate(() =>
        (globalThis as any).__livecode.setText("js", 'console.log("hi from js", 1 + 1)')
      );
      await a.waitForFunction(
        () => (globalThis as any).__livecode.console.some((e: any) => e.text === "hi from js 2"),
        null,
        { timeout: 10_000 },
      );

      // an infinite loop is stopped; the editor stays responsive
      await b.evaluate(() =>
        (globalThis as any).__livecode.setText("js", "let n = 0; while (true) { n++; }")
      );
      await a.waitForFunction(
        () => (globalThis as any).__livecode.console.some((e: any) => e.text.startsWith("Loop stopped")),
        null,
        { timeout: 15_000 },
      );
      assertEquals(await a.evaluate(() => 1 + 1), 2);

      // keyboard only: command palette → switch theme (per person: B keeps its own)
      const before = await b.evaluate(() => (globalThis as any).__livecode.theme());
      await a.keyboard.press("F1");
      await a.waitForSelector("#palette[open]");
      await a.keyboard.type("high contrast dark");
      await a.keyboard.press("Enter");
      await a.waitForFunction(() => (globalThis as any).__livecode.theme() === "hc-dark");
      assertEquals(await b.evaluate(() => (globalThis as any).__livecode.theme()), before);

      // keymap switch to Vim from the palette: the vim status panel appears, `:w` runs the preview
      await a.keyboard.press("F1");
      await a.keyboard.type("keymap vim");
      await a.keyboard.press("Enter");
      await a.waitForFunction(() => (globalThis as any).__livecode.keymap() === "vim");
      await a.click("#panel-html .cm-content");
      await a.waitForSelector("#panel-html .cm-vim-panel", { timeout: 5_000 });
      await a.keyboard.press("Escape");
      const rendersBefore = await a.evaluate(() => (globalThis as any).__livecode.renders());
      await a.keyboard.type(":w");
      await a.keyboard.press("Enter");
      await a.waitForFunction((n) => (globalThis as any).__livecode.renders() > n, rendersBefore, {
        timeout: 5_000,
      });

      // settings dialog opens with its shortcut table filled
      await a.click("#settings-btn");
      await a.waitForSelector("#settings[open]");
      assert((await a.locator("#kb-table tbody tr").count()) > 40);
      await a.keyboard.press("Escape");

      // the room survives everyone leaving: a new visitor gets the edits from disk
      await ctxA.close();
      await ctxB.close();
      await new Promise((r) => setTimeout(r, 500));
      const ctxC = await browser.newContext();
      const c = await ctxC.newPage();
      await c.goto(roomUrl);
      await c.waitForFunction(() => (globalThis as any).__livecode?.ready === true);
      assert((await c.evaluate(() => (globalThis as any).__livecode.text("html"))).includes("Hello from A"));
      await ctxC.close();

      assertEquals(errors.filter((e) => !e.includes("favicon")), []);
    } finally {
      await browser.close();
      await server.shutdown();
      await rooms.close();
    }
  },
});
