// deno-lint-ignore-file no-explicit-any
// End-to-end preview screen (/r/<room>/view): A opens it from the editor's preview header, B edits. The
// screen shows the page alone and stays live, is never counted as a person (an eye in the people list),
// runs again when A presses Run with auto-refresh off, runs TypeScript, offers fullscreen, and its eye goes
// away when it closes. Soft checks, one report. Local server only.
// Run: deno task build && CHROME_PATH=/path/to/chrome deno test --allow-all e2e/viewer_test.ts

import { type Browser, chromium, type Page } from "playwright-core";
import { loadAssets } from "../src/server/assets.ts";
import { loadConfig } from "../src/server/config.ts";
import { makeHandler } from "../src/server/http.ts";
import { setLogLevel } from "../src/server/log.ts";
import { RoomManager } from "../src/server/rooms.ts";
import { Store } from "../src/server/store.ts";

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
const setText = (p: Page, f: string, s: string) =>
  p.evaluate(([f, s]) => (globalThis as any).__livecode.setText(f, s), [f, s] as const);

/** Polled from here (the app's CSP refuses eval inside the page). */
async function expectTrue(p: Page, expr: string, what: string, timeout = 5000) {
  const end = Date.now() + timeout;
  do {
    if (await p.evaluate(expr).catch(() => false)) return;
    await sleep(75);
  } while (Date.now() < end);
  throw new Error(`not true after ${timeout} ms: ${what}`);
}

/** The text of `selector` in the page's shown frame, polled until it is `want`. */
async function frameText(p: Page, host: string, selector: string, want: string, timeout = 10_000) {
  let got = "";
  const end = Date.now() + timeout;
  do {
    const h = await p.$(`#${host} iframe.preview-frame:not(.pending)`);
    const f = await h?.contentFrame();
    got = (await f?.locator(selector).first().textContent({ timeout: 1000 }).catch(() => "")) ?? "";
    if (got === want) return;
    await sleep(150);
  } while (Date.now() < end);
  throw new Error(`${selector} shows ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

interface Result {
  name: string;
  ok: boolean;
  detail?: string;
}

Deno.test({
  name: "e2e: preview screen — live page alone, not a person (eye), Run, TypeScript, fullscreen",
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
      const a = await ctxA.newPage();
      const b = await ctxB.newPage();
      watch(a, "A");
      watch(b, "B");
      await a.goto(`${base}/new`);
      await a.waitForURL(/\/r\/[a-z2-9]{12}$/);
      const room = a.url();
      await ready(a);
      await b.goto(room);
      await ready(b);
      await a.evaluate(() => {
        const k = "livecode.settings.v1";
        const cur = JSON.parse(localStorage.getItem(k) ?? "{}");
        localStorage.setItem(k, JSON.stringify({ ...cur, name: "Ada", previewDelay: 200 }));
      });
      await a.reload();
      await ready(a);
      await setText(a, "html", '<h1 id="t">Hello screen</h1>');
      await setText(a, "js", "");

      let v: Page | null = null;
      await check("open: the preview header's button opens /r/<room>/view in a new tab", async () => {
        const [popup] = await Promise.all([ctxA.waitForEvent("page"), a.click("#preview-popout")]);
        v = popup;
        watch(v, "screen");
        await v.waitForURL(/\/r\/[a-z2-9]{12}\/view$/);
        await ready(v);
        await expectTrue(
          v,
          `!document.getElementById("viewer").hidden && document.getElementById("app").hidden`,
          "screen only",
        );
      });

      await check("page: the screen shows the room's page alone, full window", async () => {
        await frameText(v!, "viewer-frames", "#t", "Hello screen");
        const size = await v!.evaluate(() => {
          const f = document.querySelector("#viewer-frames iframe.preview-frame:not(.pending)")!
            .getBoundingClientRect();
          return [Math.round(f.width), Math.round(f.height), innerWidth, innerHeight];
        });
        if (size[0] !== size[2] || size[1] !== size[3]) throw new Error(`frame ${size}`);
        await shot(v!, "screen-01-page");
      });

      await check("people: not a person — the count stays 2, B sees Ada's eye", async () => {
        await expectTrue(b, `(globalThis).__livecode.previewScreens() === 1`, "B knows the screen");
        for (const p of [a, b]) await expectTrue(p, `(globalThis).__livecode.peers() === 2`, "2 people");
        await expectTrue(
          b,
          `document.getElementById("conn-status").textContent.includes("2 people · 1 preview screen")`,
          "status",
        );
        await expectTrue(
          b,
          `[...document.querySelectorAll("#peers .viewer-eye")].map((e) => e.getAttribute("aria-label")).join() === "Ada's preview screen"`,
          "eye with its owner's name",
        );
        await expectTrue(
          b,
          `![...document.querySelectorAll("#peers .avatar:not(.viewer-eye)")].some((e) => e.title.includes("preview"))`,
          "no avatar",
        );
        await shot(b, "screen-02-eye");
      });

      await check("live: B's edit reaches the screen", async () => {
        await setText(b, "html", '<h1 id="t">Edited by B</h1>');
        await frameText(v!, "viewer-frames", "#t", "Edited by B");
      });

      await check(
        "Run: auto-refresh off (A's setting) → the screen waits, then runs with A's Run",
        async () => {
          await a.evaluate(() => {
            const k = "livecode.settings.v1";
            const cur = JSON.parse(localStorage.getItem(k) ?? "{}");
            localStorage.setItem(k, JSON.stringify({ ...cur, autoRun: false }));
          });
          await a.reload();
          await ready(a);
          await sleep(300); // the screen reads the change (storage event)
          await setText(b, "html", '<h1 id="t">Waiting for Run</h1>');
          await sleep(1200);
          await frameText(v!, "viewer-frames", "#t", "Edited by B", 1000);
          await a.click("#run-btn");
          await frameText(v!, "viewer-frames", "#t", "Waiting for Run");
          await a.evaluate(() => {
            const k = "livecode.settings.v1";
            const cur = JSON.parse(localStorage.getItem(k) ?? "{}");
            localStorage.setItem(k, JSON.stringify({ ...cur, autoRun: true }));
          });
          await a.reload();
          await ready(a);
        },
      );

      await check("TypeScript: the screen runs the room's TypeScript", async () => {
        await setText(b, "html", '<h1 id="t"></h1>');
        await b.click("#tab-js");
        await b.click("#ts-toggle");
        await setText(
          b,
          "js",
          'interface Msg { text: string }\nconst m: Msg = { text: "typed" };\n(document.getElementById("t") as HTMLElement).textContent = m.text;\n',
        );
        await frameText(v!, "viewer-frames", "#t", "typed", 15_000);
      });

      await check("fullscreen: the screen's button (and its bar, by keyboard)", async () => {
        await v!.bringToFront();
        await v!.focus("#viewer-fullscreen");
        await expectTrue(
          v!,
          `getComputedStyle(document.getElementById("viewer-bar")).opacity === "1"`,
          "bar shown on focus",
          3000,
        );
        await v!.keyboard.press("Enter");
        await expectTrue(v!, `!!document.fullscreenElement`, "fullscreen on", 3000);
        await expectTrue(
          v!,
          `document.getElementById("viewer-fullscreen").getAttribute("aria-pressed") === "true"`,
          "pressed",
        );
        await shot(v!, "screen-03-fullscreen");
        await v!.evaluate(() => document.exitFullscreen());
        await expectTrue(v!, `!document.fullscreenElement`, "fullscreen off", 3000);
      });

      await check("close: the eye goes away", async () => {
        await v!.close();
        await expectTrue(b, `(globalThis).__livecode.previewScreens() === 0`, "screen gone", 8000);
        await expectTrue(b, `!document.querySelector("#peers .viewer-eye")`, "no eye", 3000);
        await expectTrue(b, `(globalThis).__livecode.peers() === 2`, "still 2 people");
      });

      await check("no page errors anywhere", () => {
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
      throw new Error(
        `${failed.length} preview screen check(s) failed:\n${failed.map((r) => r.name).join("\n")}`,
      );
    }
  },
});
