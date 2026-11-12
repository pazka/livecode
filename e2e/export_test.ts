// deno-lint-ignore-file no-explicit-any
// End-to-end export (owner 2026-11-12: "export the code into a single webpage named after the room … so I can
// share it easily"): the toolbar's download button gives <room>.html, one file with the three files in it and
// nothing of the preview's own; opened straight from disk it works (CSS applied, script run, accents intact).
// A TypeScript room exports the JavaScript the preview runs; the palette's command does the same.
// Soft checks, one report. Local server only.
// Run: deno task build && CHROME_PATH=/path/to/chrome deno test --allow-all e2e/export_test.ts

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

interface Result {
  name: string;
  ok: boolean;
  detail?: string;
}

const HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
  <title>Salon</title>
</head>
<body>
  <h1 id="t">Café crème ✓</h1>
  <p id="out"></p>
</body>
</html>
`;

Deno.test({
  name: "e2e: export — <room>.html, one file, works from disk (JS and TypeScript rooms)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    setLogLevel("error");
    const dataDir = await Deno.makeTempDir();
    const dlDir = await Deno.makeTempDir();
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
      const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, acceptDownloads: true });
      const a = await ctx.newPage();
      watch(a, "editor");
      await a.goto(`${base}/r/name-of-the-room`);
      await ready(a);
      await setText(a, "html", HTML);
      await setText(a, "css", "h1 { color: rgb(200, 0, 0); }");
      await setText(a, "js", 'document.getElementById("out").textContent = "ran " + [1, 2].length;');

      /** Downloads through `act`, returns the file's name and its saved path. */
      const download = async (act: () => Promise<void>) => {
        const [d] = await Promise.all([a.waitForEvent("download", { timeout: 10_000 }), act()]);
        const path = `${dlDir}/${d.suggestedFilename()}`;
        await d.saveAs(path);
        return { name: d.suggestedFilename(), path };
      };
      /** Opens a downloaded file straight from disk, as the person they send it to would. */
      const openFile = async (path: string) => {
        const p = await ctx.newPage();
        watch(p, "file");
        await p.goto(`file://${path}`);
        return p;
      };

      let js = { name: "", path: "" };
      await check("button: downloads name-of-the-room.html and says so", async () => {
        js = await download(() => a.click("#export-page"));
        if (js.name !== "name-of-the-room.html") throw new Error(`file name ${js.name}`);
        await expectTrue(
          a,
          `!document.getElementById("copy-pop").hidden && document.getElementById("copy-pop").textContent === "Downloaded name-of-the-room.html"`,
          "popover",
        );
        await shot(a, "export-01-downloaded");
      });

      await check("file: the three files in one document, nothing of the preview's own", async () => {
        const bytes = await Deno.readFile(js.path);
        if (bytes[0] !== 0xef || bytes[1] !== 0xbb || bytes[2] !== 0xbf) throw new Error("no UTF-8 mark");
        const text = new TextDecoder().decode(bytes);
        for (
          const want of ["<title>Salon</title>", "Café crème ✓", "rgb(200, 0, 0)", '"ran " + [1, 2].length']
        ) {
          if (!text.includes(want)) throw new Error(`missing ${want}`);
        }
        for (const ours of ["__lc", "postMessage", "sourceURL"]) {
          if (text.includes(ours)) throw new Error(`contains ${ours}`);
        }
      });

      await check(
        "file: opened from disk, the page works (CSS, script, accents, standards mode)",
        async () => {
          const p = await openFile(js.path);
          await expectTrue(p, `document.getElementById("out").textContent === "ran 2"`, "script ran");
          await expectTrue(p, `document.getElementById("t").textContent === "Café crème ✓"`, "accents");
          await expectTrue(
            p,
            `getComputedStyle(document.getElementById("t")).color === "rgb(200, 0, 0)"`,
            "CSS applied",
          );
          await expectTrue(
            p,
            `document.compatMode === "CSS1Compat" && document.title === "Salon"`,
            "doctype",
          );
          await shot(p, "export-02-opened");
          await p.close();
        },
      );

      await check("TypeScript room: the palette's command exports the JavaScript that runs", async () => {
        await a.click("#tab-js");
        await a.click("#ts-toggle");
        await expectTrue(a, `(globalThis).__livecode.scriptLang() === "ts"`, "TypeScript on");
        await setText(
          a,
          "js",
          "interface Point { x: number; y: number }\nconst p: Point = { x: 3, y: 4 };\n" +
            'document.getElementById("out")!.textContent = `ts ${Math.hypot(p.x, p.y)}`;',
        );
        const ts = await download(async () => {
          await a.keyboard.press("F1");
          await a.keyboard.type("Download the page");
          await expectTrue(
            a,
            `[...document.querySelectorAll("#palette-list [role=option]")][0]?.textContent.includes("Download the page")`,
            "palette entry",
          );
          await a.keyboard.press("Enter");
        });
        if (ts.name !== "name-of-the-room.html") throw new Error(`file name ${ts.name}`);
        const text = await Deno.readTextFile(ts.path);
        if (/interface Point|: Point|\)!\./.test(text)) throw new Error("types left in the file");
        const p = await openFile(ts.path);
        await expectTrue(p, `document.getElementById("out").textContent === "ts 5"`, "script ran");
        await p.close();
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
      await Deno.remove(dlDir, { recursive: true }).catch(() => {});
    }

    const pass = results.filter((r) => r.ok).length;
    console.log([
      ...results.map((r) => `${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `\n      → ${r.detail}`}`),
      `SUMMARY pass=${pass} fail=${results.length - pass} total=${results.length}`,
    ].join("\n"));
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      throw new Error(`${failed.length} export check(s) failed:\n${failed.map((r) => r.name).join("\n")}`);
    }
  },
});
