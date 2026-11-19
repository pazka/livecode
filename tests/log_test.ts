// Logging standard (hosh-management AGENTS.md section 11): one JSON object per line with ts, level, service,
// version, event, msg; one startup and one shutdown line; requests logged only when they matter, with req_id,
// method, route template, status and dur_ms; `err` on error lines; no room id, path or query string anywhere.

import { assert, assertEquals, assertMatch } from "@std/assert";
import { loadConfig } from "../src/server/config.ts";
import { logShutdown, logStartup } from "../src/server/lifecycle.ts";
import { errField, log, roomTag, setLogLevel, setLogSink, setLogVersion } from "../src/server/log.ts";
import { Store } from "../src/server/store.ts";
import { sleep, startServer } from "./helpers.ts";
import { until, YClient } from "../src/server/yclient.ts";

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
  assertEquals(
    loadConfig((k) => ({ APP_LOG_LEVEL: "debug" } as Record<string, string>)[k]).logLevel,
    "debug",
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

Deno.test({
  name: "log: a request slower than 1 s gives one warn line with the route template, status and dur_ms",
  ...opts,
  async fn() {
    const srv = await startServer();
    try {
      const orig = srv.rooms.store.probe.bind(srv.rooms.store);
      srv.rooms.store.probe = async () => {
        await sleep(1100);
        return orig();
      };
      let res!: Response;
      const recs = await capture("info", async () => {
        res = await fetch(`${srv.base}/healthz?token=zz`, { headers: { "x-request-id": "qa-slow-1" } });
        await res.body?.cancel();
      });
      assertEquals(res.status, 200);
      assertEquals(recs.length, 1, JSON.stringify(recs));
      const s = recs[0];
      checkFormat(s);
      assertEquals([s.level, s.event, s.msg, s.req_id, s.method, s.route, s.status], [
        "warn",
        "http",
        "slow request",
        "qa-slow-1",
        "GET",
        "/healthz",
        200,
      ]);
      assert(typeof s.dur_ms === "number" && s.dur_ms > 1000, `dur_ms ${s.dur_ms}`);
      assert(!JSON.stringify(s).includes("token"), JSON.stringify(s));
    } finally {
      await srv.stop();
    }
  },
});

/** Sends a raw WebSocket upgrade and returns the status line and headers of the answer. */
async function rawUpgrade(
  base: string,
  path: string,
  reqId?: string,
): Promise<{ status: number; headers: Headers }> {
  const port = Number(new URL(base).port);
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  try {
    const lines = [
      `GET ${path} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      ...(reqId ? [`X-Request-Id: ${reqId}`] : []),
    ];
    await conn.write(new TextEncoder().encode(lines.join("\r\n") + "\r\n\r\n"));
    let head = "";
    const buf = new Uint8Array(4096);
    while (!head.includes("\r\n\r\n")) {
      const n = await conn.read(buf);
      if (n === null) break;
      head += new TextDecoder().decode(buf.subarray(0, n));
    }
    const [statusLine, ...rest] = head.split("\r\n\r\n")[0].split("\r\n");
    const headers = new Headers();
    for (const l of rest) {
      const i = l.indexOf(":");
      headers.append(l.slice(0, i).trim(), l.slice(i + 1).trim());
    }
    return { status: Number(statusLine.split(" ")[1]), headers };
  } finally {
    conn.close();
  }
}

Deno.test({
  name: "log: the WebSocket upgrade (101) returns x-request-id, and the socket still works",
  ...opts,
  async fn() {
    const srv = await startServer();
    const a = new YClient(`${srv.ws}/ws/req-id-room`);
    try {
      const echoed = await rawUpgrade(srv.base, "/ws/req-id-room", "qa-ws-1");
      assertEquals(echoed.status, 101);
      assertEquals(echoed.headers.get("x-request-id"), "qa-ws-1");
      assertEquals(echoed.headers.get("upgrade")?.toLowerCase(), "websocket");
      assert(echoed.headers.get("sec-websocket-accept"), "Deno's own upgrade headers are kept");
      const generated = await rawUpgrade(srv.base, "/ws/req-id-room");
      assertEquals(generated.status, 101);
      assertMatch(generated.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/);
      // a real client in the same room still gets the document and syncs
      await a.ready();
      assert(a.text("css").includes("font-family"));
    } finally {
      await a.close();
      await srv.stop();
    }
  },
});

Deno.test({
  name: "log: a 5xx answer that is not an exception gives one error http line (/healthz 503)",
  ...opts,
  async fn() {
    const srv = await startServer();
    try {
      srv.rooms.store.probe = () => Promise.resolve(false); // the volume is not writable: /healthz is 503
      let res!: Response;
      const recs = await capture("info", async () => {
        res = await fetch(`${srv.base}/healthz?token=zz`);
        await res.body?.cancel();
      });
      assertEquals(res.status, 503);
      assertEquals(recs.length, 1, JSON.stringify(recs));
      const e = recs[0];
      checkFormat(e);
      assertEquals([e.level, e.event, e.method, e.route, e.status], [
        "error",
        "http",
        "GET",
        "/healthz",
        503,
      ]);
      assertMatch(res.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/);
      assertEquals(e.req_id, res.headers.get("x-request-id"));
      assert(!("err" in e), "no err key on a 5xx that is not an exception");
      assert(!JSON.stringify(e).includes("token"), JSON.stringify(e));
    } finally {
      await srv.stop();
    }
  },
});

/** One error line of `event` with err (type, message, stack) and the room tag; the raw id appears nowhere. */
function checkRoomError(recs: Line[], event: string, id: string) {
  const mine = recs.filter((r) => r.event === event);
  assertEquals(mine.length, 1, JSON.stringify(recs));
  const e = mine[0];
  checkFormat(e);
  assertEquals([e.level, e.room], ["error", roomTag(id)]);
  const err = e.err as Record<string, string>;
  assertEquals(err.type, "Error");
  assert(err.message.includes(roomTag(id)), err.message);
  assert(typeof err.stack === "string" && err.stack.length > 0);
  for (const r of recs) assert(!JSON.stringify(r).includes(id), JSON.stringify(r));
}

Deno.test({
  name: "log: a failed room save gives one room_save_failed error line, the room id hidden",
  ...opts,
  async fn() {
    const id = "qa-secret-save-room";
    const srv = await startServer();
    const a = new YClient(`${srv.ws}/ws/${id}`);
    const realSave = srv.rooms.store.save.bind(srv.rooms.store);
    try {
      await a.ready();
      const room = srv.rooms.rooms.get(id)!;
      srv.rooms.store.save = () =>
        Promise.reject(new Error(`EACCES: open '/data/rooms/${id}.ydoc' (room ${id})`));
      a.doc.getText("js").insert(0, "// edit\n");
      await until(() => room.dirty, 3000, "edit reaches the server");
      const recs = await capture("info", () => room.save());
      checkRoomError(recs, "room_save_failed", id);
      assert(room.dirty, "the edit stays unsaved and is retried");
    } finally {
      srv.rooms.store.save = realSave; // the retry and the final save on stop succeed
      await a.close();
      await srv.stop();
    }
  },
});

Deno.test({
  name: "log: a failed WebSocket join gives one ws_join_failed error line, the room id hidden",
  ...opts,
  async fn() {
    const id = "qa-secret-join-room";
    const srv = await startServer();
    srv.rooms.join = () => Promise.reject(new Error(`EIO: read '/data/rooms/${id}.ydoc' (room ${id})`));
    let a!: YClient;
    try {
      const recs = await capture("info", async () => {
        a = new YClient(`${srv.ws}/ws/${id}`);
        const ev = await a.closed;
        assertEquals(ev.code, 1011);
      });
      checkRoomError(recs, "ws_join_failed", id);
    } finally {
      await a?.close();
      await srv.stop();
    }
  },
});

Deno.test({
  name: "log: a failed WebSocket leave gives one ws_leave_failed error line, the room id hidden",
  ...opts,
  async fn() {
    const id = "qa-secret-leave-room";
    const srv = await startServer();
    const a = new YClient(`${srv.ws}/ws/${id}`);
    const realLeave = srv.rooms.leave.bind(srv.rooms);
    let calls = 0;
    try {
      await a.ready();
      srv.rooms.leave = () => {
        calls++;
        return Promise.reject(new Error(`EIO: write '/data/rooms/${id}.ydoc' (room ${id})`));
      };
      const recs = await capture("info", async () => {
        await a.close();
        await until(() => calls > 0, 3000, "the server sees the close");
        await sleep(50); // the rejection is logged
      });
      assertEquals(calls, 1);
      checkRoomError(recs, "ws_leave_failed", id);
    } finally {
      srv.rooms.leave = realLeave;
      await a.close();
      await srv.stop();
    }
  },
});

Deno.test({
  name: "log: a failed expiry job gives gc_failed error lines (first run and interval), room file hidden",
  ...opts,
  async fn() {
    const id = "qa-secret-gc-room";
    const srv = await startServer();
    let calls = 0;
    srv.rooms.store.gc = () => {
      calls++;
      return Promise.reject(new Error(`EACCES: unlink '/data/rooms/${id}.ydoc'`));
    };
    try {
      const recs = await capture("info", async () => {
        srv.rooms.startGc(30);
        await until(() => calls >= 2, 3000, "first run and one interval run");
        await srv.rooms.close(); // stops the timer
        await sleep(20); // the last rejection is logged
      });
      const failed = recs.filter((r) => r.event === "gc_failed");
      assertEquals(failed.length, calls, JSON.stringify(recs));
      for (const e of failed) {
        checkFormat(e);
        assertEquals(e.level, "error");
        const err = e.err as Record<string, string>;
        assertEquals(err.type, "Error");
        assert(err.message.includes(`rooms/${roomTag(id)}.ydoc`), err.message);
        assert(typeof err.stack === "string" && err.stack.includes(`rooms/${roomTag(id)}.ydoc`), err.stack);
      }
      for (const r of recs) assert(!JSON.stringify(r).includes(id), JSON.stringify(r));
      const n = calls;
      await sleep(80);
      assertEquals(calls, n, "the timer is stopped");
    } finally {
      await srv.stop();
    }
  },
});

Deno.test({
  name: "log: a real join and leave give one room_open (info) and one room_unloaded (debug), id hidden",
  ...opts,
  async fn() {
    const id = "qa-secret-open-room";
    const srv = await startServer({ graceMs: 50 });
    let a!: YClient;
    try {
      const recs = await capture("debug", async () => {
        a = new YClient(`${srv.ws}/ws/${id}`);
        await a.ready();
        await a.close();
        await until(() => !srv.rooms.rooms.has(id), 3000, "the room is unloaded after the grace period");
      });
      const open = recs.filter((r) => r.event === "room_open");
      assertEquals(open.length, 1, JSON.stringify(recs));
      checkFormat(open[0]);
      assertEquals([open[0].level, open[0].room, open[0].stored], ["info", roomTag(id), false]);
      assertEquals(typeof open[0].bytes, "number");
      const gone = recs.filter((r) => r.event === "room_unloaded");
      assertEquals(gone.length, 1, JSON.stringify(recs));
      checkFormat(gone[0]);
      assertEquals([gone[0].level, gone[0].room], ["debug", roomTag(id)]);
      for (const r of recs) assert(!JSON.stringify(r).includes(id), JSON.stringify(r));
    } finally {
      await a?.close();
      await srv.stop();
    }
  },
});
