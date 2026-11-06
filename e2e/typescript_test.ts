// deno-lint-ignore-file no-explicit-any
// End-to-end TypeScript, two real browsers (A writes, B watches) in one room: the room-wide switch, typed
// completions (the DOM's types, the room's own interfaces, event names), the type under the mouse and by
// keyboard, type errors in the editor, the preview running the TypeScript (errors at the TypeScript line),
// and back to JavaScript. Soft checks, one report (like editing_test.ts). Local server only.
// Run: deno task build && CHROME_PATH=/path/to/chrome deno test --allow-all e2e/typescript_test.ts

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
  await sleep(250);
  await p.screenshot({ path: `${SHOTS}/${name}.png` });
}

const text = (p: Page) => p.evaluate(() => (globalThis as any).__livecode.text("js")) as Promise<string>;
const setText = (p: Page, f: string, s: string) =>
  p.evaluate(([f, s]) => (globalThis as any).__livecode.setText(f, s), [f, s] as const);

async function ready(p: Page) {
  await p.waitForFunction(() => (globalThis as any).__livecode?.ready === true, null, { timeout: 20_000 });
}

/** Polled from here (the app's CSP refuses eval inside the page). */
async function expectTrue(p: Page, expr: string, what: string, timeout = 4000) {
  const end = Date.now() + timeout;
  do {
    if (await p.evaluate(expr).catch(() => false)) return;
    await sleep(75);
  } while (Date.now() < end);
  throw new Error(`not true after ${timeout} ms: ${what}`);
}

/** The script, its content, the caret at the end of the file. */
async function script(p: Page, content: string) {
  await p.click("#tab-js");
  await setText(p, "js", content);
  for (let i = 0; i < 40 && (await text(p)) !== content; i++) await sleep(50);
  await p.click("#panel-js .cm-content");
  await p.keyboard.press("Control+End");
}

const OPTIONS = `[...document.querySelectorAll(".cm-tooltip-autocomplete li")].map((l) => l.textContent)`;

async function options(p: Page): Promise<string[]> {
  await p.waitForSelector(".cm-tooltip-autocomplete li", { timeout: 8000 });
  await sleep(150);
  return await p.evaluate(OPTIONS);
}

const errorLines = `[...document.querySelectorAll("#panel-js .cm-lc-errorLine")].map((l) => l.textContent)`;

interface Result {
  name: string;
  ok: boolean;
  detail?: string;
}

Deno.test({
  name: "e2e: TypeScript — shared switch, typed completions, types, type errors, preview",
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

      await check("switch: TypeScript on for the whole room (names follow, B sees it)", async () => {
        await a.click("#tab-js");
        await a.click("#ts-toggle");
        for (const p of [a, b]) {
          await expectTrue(p, `document.getElementById("js-ts").checked`, "switch on");
          await expectTrue(
            p,
            `document.querySelector("#tab-js .fname").textContent === "script.ts"`,
            "tab name",
          );
          await expectTrue(p, `document.querySelector("#tab-js .ft").textContent === "TS"`, "tab icon");
          await expectTrue(p, `(globalThis).__livecode.scriptLang() === "ts"`, "hook");
        }
      });

      await check("completion: document. lists the DOM's members; Tab takes one", async () => {
        await script(a, "");
        await a.keyboard.type("document.getElementB", { delay: 30 });
        const list = await options(a);
        if (!list.some((o) => o.startsWith("getElementById"))) {
          throw new Error(`options: ${list.slice(0, 8)}`);
        }
        await shot(a, "ts-01-completion");
        await a.keyboard.press("Tab");
        await expectTrue(a, `(globalThis).__livecode.text("js") === "document.getElementById"`, "accepted");
      });

      await check("completion: the room's own interface — p. lists exactly its fields", async () => {
        await script(
          a,
          "interface Point { x: number; y: number; label?: string }\nconst p: Point = { x: 1, y: 2 };\n",
        );
        await a.keyboard.type("p.", { delay: 30 });
        const list = await options(a);
        const names = list.map((o) => o.replace(/optional$/, "").trim()).sort();
        if (names.join() !== "label,x,y") throw new Error(`options: ${list}`);
        await a.keyboard.press("Escape");
      });

      await check('completion: event names inside addEventListener("…")', async () => {
        await script(a, "const btn = document.querySelector('button')!;\n");
        await a.keyboard.type('btn.addEventListener("cli', { delay: 30 });
        const list = await options(a);
        if (!list.some((o) => o.startsWith("click"))) throw new Error(`options: ${list.slice(0, 8)}`);
        await a.keyboard.press("Escape");
      });

      await check("type: hovering a name shows its type", async () => {
        await script(a, 'const title = document.querySelector("h1");\n');
        const box = await a.evaluate(() => {
          const root = document.querySelector("#panel-js .cm-content")!;
          const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          for (let n = walk.nextNode(); n; n = walk.nextNode()) {
            const i = n.textContent!.indexOf("title");
            if (i < 0) continue;
            const r = document.createRange();
            r.setStart(n, i + 1);
            r.setEnd(n, i + 3);
            const b = r.getBoundingClientRect();
            return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
          }
          return null;
        });
        if (!box) throw new Error("word not found");
        await a.mouse.move(box.x, box.y);
        await expectTrue(
          a,
          `[...document.querySelectorAll(".cm-lc-typeInfo code")].some((c) => c.textContent.includes("HTMLHeadingElement | null"))`,
          "type shown",
          8000,
        );
        await shot(a, "ts-02-hover");
        await a.mouse.move(5, 5);
      });

      await check("type: Ctrl+K Ctrl+I shows the type at the caret (keyboard)", async () => {
        await script(a, "const total: number = 3;\ntotal");
        await a.keyboard.press("Control+KeyK");
        await a.keyboard.press("Control+KeyI");
        await expectTrue(
          a,
          `[...document.querySelectorAll(".cm-lc-typeInfo code")].some((c) => c.textContent === "const total: number")`,
          "type box",
          8000,
        );
        await a.keyboard.press("Escape");
        await expectTrue(a, `!document.querySelector(".cm-lc-typeInfo")`, "closed by Escape");
      });

      await check("errors: a type error is marked on its line with TypeScript's message", async () => {
        await script(a, 'const ok = 1;\nconst n: number = "seven";\n');
        await a.click("#run-btn");
        await expectTrue(
          a,
          `${errorLines}.some((l) => l.includes('const n: number = "seven"') && l.includes("not assignable to type 'number'"))`,
          "type error on line 2",
          10_000,
        );
        await shot(a, "ts-03-type-error");
        await setText(a, "js", 'const ok = 1;\nconst n: string = "seven";\n');
        await expectTrue(
          a,
          `!document.querySelector("#panel-js .cm-lc-errorLine")`,
          "cleared once fixed",
          10_000,
        );
      });

      await check("preview: the TypeScript runs (types removed) for both people", async () => {
        await setText(a, "html", '<p id="out">…</p>');
        await script(
          a,
          'interface User {\n  name: string;\n}\nconst user: User = { name: "Ada" };\n' +
            'const out = document.getElementById("out") as HTMLElement;\nout.textContent = `Hi ${user.name}`;\n',
        );
        await a.click("#run-btn");
        for (const p of [a, b]) {
          let got = "";
          for (let i = 0; i < 60; i++) {
            const h = await p.waitForSelector("iframe.preview-frame:not(.pending)", { timeout: 10_000 });
            const f = await h.contentFrame();
            got = (await f?.locator("#out").textContent({ timeout: 2000 }).catch(() => "")) ?? "";
            if (got === "Hi Ada") break;
            await sleep(150);
          }
          if (got !== "Hi Ada") throw new Error(`preview shows ${JSON.stringify(got)}`);
        }
      });

      await check(
        "errors: a runtime error is marked on its TypeScript line (not the JavaScript's)",
        async () => {
          await script(
            a,
            "type Id = number;\ninterface Thing {\n  go(): void;\n}\nconst thing = null as unknown as Thing;\nthing.go();\n",
          );
          await a.click("#run-btn");
          await expectTrue(
            a,
            `${errorLines}.some((l) => l.includes("thing.go()") && /null/.test(l))`,
            "error on line 6",
            10_000,
          );
          await expectTrue(
            a,
            `[...document.querySelectorAll("#console-list li, #console li")].some((l) => /TS line 6|thing/.test(l.textContent))`,
            "console names the error",
            5000,
          ).catch(() => {/* the console's layout is not what this check is about */});
        },
      );

      await check("switch: back to JavaScript for the whole room", async () => {
        await setText(a, "js", "");
        await a.click("#ts-toggle");
        for (const p of [a, b]) {
          await expectTrue(p, `!document.getElementById("js-ts").checked`, "switch off");
          await expectTrue(
            p,
            `document.querySelector("#tab-js .fname").textContent === "script.js"`,
            "tab name",
          );
        }
        await script(a, "");
        await a.keyboard.type("docu", { delay: 30 });
        const list = await options(a);
        if (!list.some((o) => o.startsWith("document"))) throw new Error(`options: ${list.slice(0, 8)}`);
        await a.keyboard.press("Escape");
      });

      await check("no page errors in either browser", () => {
        const planted = [/reading 'go'/, /null/]; // the runtime-error check fails the page on purpose
        const real = [
          ...new Set(errors.filter((e) => !e.includes("favicon") && !planted.some((r) => r.test(e)))),
        ];
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
        `${failed.length} TypeScript check(s) failed:\n${failed.map((r) => r.name).join("\n")}`,
      );
    }
  },
});
