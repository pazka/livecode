// A real server on an ephemeral loopback port with a temp data dir, for the integration tests.

import { type Limits, loadConfig } from "../src/server/config.ts";
import { type Asset, makeHandler } from "../src/server/http.ts";
import { setLogLevel } from "../src/server/log.ts";
import { RoomManager } from "../src/server/rooms.ts";
import { Store } from "../src/server/store.ts";

const enc = (s: string) => new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;

export const FAKE_ASSETS = new Map<string, Asset>([
  ["/index.html", {
    type: "text/html; charset=utf-8",
    body: enc('<div id="app"></div><script type="module" src="/app.js?v=abc123"></script>'),
    immutable: false,
  }],
  ["/app.js", { type: "text/javascript; charset=utf-8", body: enc("x".repeat(120_000)), immutable: true }],
  ["/app.css", { type: "text/css; charset=utf-8", body: enc("body{}"), immutable: true }],
  ["/preview.html", {
    type: "text/html; charset=utf-8",
    body: enc('<script src="/preview.js?v=1"></script>'),
    immutable: false,
  }],
  ["/preview.js", { type: "text/javascript; charset=utf-8", body: enc("1"), immutable: true }],
]);

export interface TestServer {
  base: string;
  ws: string;
  rooms: RoomManager;
  store: Store;
  dataDir: string;
  stop(): Promise<void>;
}

export async function startServer(
  opts: { dataDir?: string; limits?: Partial<Limits>; graceMs?: number } = {},
): Promise<TestServer> {
  setLogLevel("error");
  const dataDir = opts.dataDir ?? await Deno.makeTempDir({ prefix: "livecode-test-" });
  const env: Record<string, string> = {
    APP_DATA_DIR: dataDir,
    APP_BASE_URL: "http://127.0.0.1",
    LIVECODE_VERSION: "test",
  };
  const cfg = loadConfig((k) => env[k]);
  cfg.limits = { ...cfg.limits, ...opts.limits };
  const store = new Store(dataDir);
  await store.init();
  const rooms = new RoomManager(store, cfg.limits, opts.graceMs ?? 50);
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    makeHandler({ cfg, rooms, assets: FAKE_ASSETS }),
  );
  const base = `http://127.0.0.1:${server.addr.port}`;
  return {
    base,
    ws: base.replace(/^http/, "ws"),
    rooms,
    store,
    dataDir,
    async stop() {
      await server.shutdown();
      await rooms.close();
    },
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
