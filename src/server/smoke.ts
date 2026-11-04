// Capability smoke (hosh-deploy POST_DEPLOY, CI container smoke): `livecode smoke [base-url]`.
// Not a 200 check: two real clients edit one room, the edit and the cursor cross over, the room survives a
// reconnect from disk; the pages and the preview frame carry their security headers. Cleans up its room.

import { loadConfig } from "./config.ts";
import { until, YClient } from "./yclient.ts";

type Check = [name: string, fn: () => Promise<string>];

function must(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

export async function runSmoke(base: string, _args: string[]): Promise<number> {
  const ws = base.replace(/^http/, "ws");
  const room = `smoke-${crypto.randomUUID().slice(0, 8)}`;
  const marker = `smoke-${Date.now()}`;
  const cfg = loadConfig();
  const checks: Check[] = [
    ["healthz", async () => {
      const r = await fetch(`${base}/healthz`);
      const h = await r.json();
      must(r.status === 200 && h.status === "ok" && h.storage === "writable", `healthz ${JSON.stringify(h)}`);
      return `v=${h.version} rooms=${h.rooms.stored} conns=${h.connections}`;
    }],
    ["app page + bundle", async () => {
      const r = await fetch(`${base}/r/${room}`);
      const html = await r.text();
      must(r.status === 200, `status ${r.status}`);
      const csp = r.headers.get("content-security-policy") ?? "";
      must(csp.includes("frame-ancestors 'none'") && csp.includes("script-src 'self'"), `csp ${csp}`);
      const js = html.match(/src="(\/app\.js\?v=[0-9a-f]+)"/)?.[1];
      must(js, "index.html does not reference /app.js?v=<hash>");
      const b = await fetch(`${base}${js}`);
      const size = (await b.arrayBuffer()).byteLength;
      must(b.status === 200 && size > 100_000, `app.js ${b.status} ${size} B`);
      const css = await fetch(`${base}/app.css`);
      await css.body?.cancel();
      must(css.status === 200, `app.css ${css.status}`);
      return `app.js ${Math.round(size / 1024)} KiB`;
    }],
    ["preview frame isolation headers", async () => {
      const r = await fetch(`${base}/preview`);
      const body = await r.text();
      const csp = r.headers.get("content-security-policy") ?? "";
      must(r.status === 200 && body.includes("/preview.js"), `preview ${r.status}`);
      must(csp.includes("form-action 'none'") && csp.includes("frame-ancestors 'self'"), `preview csp ${csp}`);
      return "ok";
    }],
    ["/new gives a fresh room", async () => {
      const r = await fetch(`${base}/new`, { redirect: "manual" });
      await r.body?.cancel();
      const loc = r.headers.get("location") ?? "";
      must(r.status === 303 && /^\/r\/[a-z0-9]{12}$/.test(loc), `new ${r.status} ${loc}`);
      return loc.replace(/.{8}$/, "********");
    }],
    ["two clients: starter, edit and cursor cross over", async () => {
      const a = new YClient(`${ws}/ws/${room}`);
      const b = new YClient(`${ws}/ws/${room}`);
      try {
        await Promise.all([a.ready(), b.ready()]);
        must(a.text("html").includes("<h1>"), "new room has no starter html");
        a.doc.getText("html").insert(0, `<!-- ${marker} -->\n`);
        a.awareness.setLocalStateField("user", { name: "smoke", color: "#237af3" });
        await until(() => b.text("html").includes(marker), 5000, "edit reaches the second client");
        await until(
          () => [...b.awareness.getStates().values()].some((s) => s.user?.name === "smoke"),
          5000,
          "presence reaches the second client",
        );
      } finally {
        await a.close();
        await b.close();
      }
      return "ok";
    }],
    ["room persisted and reloaded", async () => {
      // the last client left: the server saves at once; give the write a moment
      const file = `${cfg.dataDir}/rooms/${room}.ydoc`;
      await until(() => {
        try {
          return Deno.statSync(file).size > 0;
        } catch {
          return false;
        }
      }, 5000, "room file written");
      const c = new YClient(`${ws}/ws/${room}`);
      try {
        await c.ready();
        must(c.text("html").includes(marker), "edit lost after reconnect");
        must((c.text("html").match(/<h1>/g) ?? []).length === 1, "starter duplicated");
      } finally {
        await c.close();
      }
      return `${Deno.statSync(file).size} B on disk`;
    }],
  ];

  let failed = 0;
  for (const [name, fn] of checks) {
    try {
      console.log(`PASS ${name}: ${await fn()}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  try {
    await Deno.remove(`${cfg.dataDir}/rooms/${room}.ydoc`);
  } catch { /* not written or no access (smoke run outside the container): GC removes smoke rooms after 1 h */ }
  console.log(failed ? `smoke: ${failed} FAILED` : `smoke: all ${checks.length} passed`);
  return failed ? 1 : 0;
}
