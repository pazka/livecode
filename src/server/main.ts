// livecode — one binary: `serve` (default), `healthcheck` (compose) and `smoke` (hosh-deploy POST_DEPLOY).

import { loadAssets } from "./assets.ts";
import { loadConfig } from "./config.ts";
import { makeHandler } from "./http.ts";
import { logShutdown, logStartup } from "./lifecycle.ts";
import { setLogLevel, setLogVersion } from "./log.ts";
import { RoomManager } from "./rooms.ts";
import { runSmoke } from "./smoke.ts";
import { Store } from "./store.ts";

async function serve() {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);
  setLogVersion(cfg.version);
  const store = new Store(cfg.dataDir);
  await store.init();
  const rooms = new RoomManager(store, cfg.limits);
  rooms.startGc();
  const handler = makeHandler({ cfg, rooms, assets: loadAssets() });
  const ctl = new AbortController();
  let signal = "";
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    Deno.addSignalListener(sig, () => {
      signal = sig;
      ctl.abort();
    });
  }
  const server = Deno.serve({
    hostname: "0.0.0.0",
    port: cfg.port,
    signal: ctl.signal,
    onListen: ({ port }) => void logStartup(cfg, store, port),
  }, handler);
  await server.finished;
  const t0 = performance.now();
  await rooms.close(); // flush unsaved edits
  logShutdown(signal, performance.now() - t0);
}

async function healthcheck(base: string): Promise<number> {
  try {
    const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(4000) });
    const body = await res.json();
    return res.status === 200 && body?.status === "ok" ? 0 : 1;
  } catch {
    return 1;
  }
}

const [cmd = "serve", ...rest] = Deno.args;
const base = rest.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:8000";
if (cmd === "serve") await serve();
else if (cmd === "healthcheck") Deno.exit(await healthcheck(base));
else if (cmd === "smoke") Deno.exit(await runSmoke(base, rest));
else {
  console.error("usage: livecode [serve | healthcheck [url] | smoke [url]]");
  Deno.exit(2);
}
