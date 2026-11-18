// Logging standard (hosh-management AGENTS.md section 11): one JSON object per line with ts, level, service,
// version, event, msg; one startup and one shutdown line; requests logged only when they matter, with req_id,
// method, route template, status and dur_ms; `err` on error lines; no room id, path or query string anywhere.

import { assert, assertEquals, assertMatch } from "@std/assert";
import { loadConfig } from "../src/server/config.ts";
import { logShutdown, logStartup } from "../src/server/lifecycle.ts";
import { errField, log, roomTag, setLogLevel, setLogSink, setLogVersion } from "../src/server/log.ts";
import { Store } from "../src/server/store.ts";
import { startServer } from "./helpers.ts";

const opts = { sanitizeOps: false, sanitizeResources: false };
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type Line = Record<string, unknown>;

/** Captures the log lines at `level` for the time of `fn`, then restores stdout and the test level. */
async function capture(level: string, fn: () => Promise<void> | void): Promise<Line[]> {
  const lines: string[] = [];
  const prev = setLogSink((l) => lines.push(l));
  setLogLevel(level);
  setLogVersion("v9.9.9-test");
  try {
    await fn();
  } finally {
    setLogSink(prev);
    setLogLevel("error");
    setLogVersion("dev");
  }
  return lines.map((l) => JSON.parse(l)); // every line is one JSON object
}

function checkFormat(rec: Line) {
  for (const k of ["ts", "level", "service", "version", "event", "msg"]) {
    assert(k in rec, `${k} missing: ${JSON.stringify(rec)}`);
  }
  assertMatch(rec.ts as string, TS);
  assert(["debug", "info", "warn", "error"].includes(rec.level as string), `level ${rec.level}`);
  assertEquals(rec.service, "livecode");
  assertEquals(rec.version, "v9.9.9-test");
  assertMatch(rec.event as string, /^[a-z][a-z0-9_]*$/);
}

Deno.test("log: startup line has version, port, data dir writable and config names without values", async () => {
  const dataDir = await Deno.makeTempDir({ prefix: "livecode-log-" });
  const env: Record<string, string> = {
    APP_DATA_DIR: dataDir,
    APP_BASE_URL: "https://secret-value.example",
    LIVECODE_MAX_ROOMS: "77",
  };
  const cfg = loadConfig((k) => env[k]);
  const store = new Store(dataDir);
  await store.init();
  const recs = await capture("info", () => logStartup(cfg, store, 8123, (k) => env[k]));
  assertEquals(recs.length, 1);
  const s = recs[0];
  checkFormat(s);
  assertEquals([s.level, s.event, s.port, s.data_dir_writable], ["info", "startup", 8123, true]);
  assertEquals(s.config, ["APP_DATA_DIR", "APP_BASE_URL", "LIVECODE_MAX_ROOMS"]);
  const raw = JSON.stringify(s);
  assert(!raw.includes("secret-value") && !raw.includes(dataDir) && !raw.includes('"77"'), raw);

  // a data dir that cannot be written: the same line, at error, says so
  await Deno.remove(dataDir, { recursive: true });
  const bad = await capture("info", () => logStartup(cfg, store, 8123, (k) => env[k]));
  assertEquals([bad[0].level, bad[0].event, bad[0].data_dir_writable], ["error", "startup", false]);

  const down = await capture("info", () => logShutdown("SIGTERM", 12.6));
  checkFormat(down[0]);
  assertEquals([down[0].event, down[0].signal, down[0].dur_ms], ["shutdown", "SIGTERM", 13]);
});

Deno.test({
  name: "log: an unhandled error in a request gives one error line with err, route template and req_id",
  ...opts,
  async fn() {
    const srv = await startServer();
    try {
      // the volume breaks: the error names the room file, which must not reach the log
      srv.rooms.store.probe = () =>
        Promise.reject(new Error(`EACCES: open '/data/rooms/my-secret-room.ydoc'`));
      let res!: Response;
      const recs = await capture("info", async () => {
        res = await fetch(`${srv.base}/healthz?token=zz`, { headers: { "x-request-id": "qa-req-1" } });
        await res.body?.cancel();
      });
      assertEquals(res.status, 500);
      assertEquals(res.headers.get("x-request-id"), "qa-req-1");
      assertEquals(recs.length, 1, JSON.stringify(recs));
      const e = recs[0];
      checkFormat(e);
      assertEquals([e.level, e.event, e.req_id, e.method, e.route, e.status], [
        "error",
        "request_failed",
        "qa-req-1",
        "GET",
        "/healthz",
        500,
      ]);
      assertEquals(typeof e.dur_ms, "number");
      const err = e.err as Record<string, string>;
      assertEquals(err.type, "Error");
      assert(err.message.includes(`rooms/${roomTag("my-secret-room")}.ydoc`), err.message);
      assert(typeof err.stack === "string" && err.stack.length > 0);
      const raw = JSON.stringify(e);
      assert(!raw.includes("my-secret-room") && !raw.includes("token"), raw);
    } finally {
      await srv.stop();
    }
  },
});

Deno.test({
  name: "log: requests are logged only when they matter; req_id is echoed or generated",
  ...opts,
  async fn() {
    const srv = await startServer();
    try {
      const get = async (path: string, init?: RequestInit) => {
        const r = await fetch(`${srv.base}${path}`, init);
        await r.body?.cancel();
        return r;
      };
      // info: a page, a room page, a 404 and /healthz write nothing
      let gen = "";
      const quiet = await capture("info", async () => {
        gen = (await get("/r/some-private-room")).headers.get("x-request-id") ?? "";
        await get("/nope");
        await get("/healthz");
      });
      assertEquals(quiet, []);
      assertMatch(gen, /^[0-9a-f-]{36}$/); // generated when the edge sent none
      // a request id that is not a plain token is replaced, never echoed
      const odd = (await get("/", { headers: { "x-request-id": "a b<script>" } })).headers.get(
        "x-request-id",
      );
      assertMatch(odd ?? "", /^[0-9a-f-]{36}$/);

      // a refused WebSocket origin is a warn line, with the route template and no room id
      const refused = await capture("info", async () => {
        const r = await get("/ws/some-private-room", {
          headers: { upgrade: "websocket", connection: "Upgrade", origin: "https://evil.example" },
        });
        assertEquals(r.status, 403);
      });
      assertEquals(refused.length, 1);
      checkFormat(refused[0]);
      assertEquals([refused[0].level, refused[0].event, refused[0].route, refused[0].status], [
        "warn",
        "http",
        "/ws/:room",
        403,
      ]);

      // debug: every request, /healthz included, with route templates only
      const all = await capture("debug", async () => {
        await get("/r/some-private-room/view");
        await get("/app.js");
        await get("/healthz");
        await get("/.env");
      });
      assertEquals(all.map((r) => [r.level, r.event, r.route, r.status]), [
        ["debug", "http", "/r/:room/view", 200],
        ["debug", "http", "/:asset", 200],
        ["debug", "http", "/healthz", 200],
        ["debug", "http", "/:other", 404],
      ]);
      for (const r of [...all, ...refused]) assert(!JSON.stringify(r).includes("some-private-room"));
    } finally {
      await srv.stop();
    }
  },
});

Deno.test("log: LOG_LEVEL filters, err carries type, message and stack, room ids are hidden", async () => {
  const recs = await capture("warn", () => {
    log("info", "dropped", "not written at warn");
    log("warn", "kept", "written at warn");
    log("error", "room_save_failed", "x", {
      room: roomTag("abc-def"),
      ...errField(new TypeError("bad abc-def"), ["abc-def"]),
    });
    log("error", "odd", "x", errField("plain"));
  });
  assertEquals(recs.map((r) => r.event), ["kept", "room_save_failed", "odd"]);
  recs.forEach(checkFormat);
  const err = recs[1].err as Record<string, string>;
  assertEquals([err.type, err.message], ["TypeError", `bad ${roomTag("abc-def")}`]);
  assert(!err.stack.includes("abc-def"));
  assertEquals(recs[2].err, { type: "string", message: "plain" });
  assertEquals(loadConfig((k) => ({ LOG_LEVEL: "debug" } as Record<string, string>)[k]).logLevel, "debug");
  assertEquals(
    loadConfig((k) => ({ LOG_LEVEL: "debug", APP_LOG_LEVEL: "warn" } as Record<string, string>)[k]).logLevel,
    "warn",
  );
});

Deno.test({
  name: "log: the expiry job writes one start and one done line with dur_ms and counts",
  ...opts,
  async fn() {
    const srv = await startServer();
    try {
      const recs = await capture("info", async () => {
        await srv.rooms.gc();
      });
      assertEquals(recs.map((r) => r.event), ["gc_start", "gc_done"]);
      recs.forEach(checkFormat);
      assertEquals(recs[1].deleted, 0);
      assertEquals(typeof recs[1].dur_ms, "number");
      assertEquals(typeof recs[1].stored, "number");
    } finally {
      await srv.stop();
    }
  },
});
