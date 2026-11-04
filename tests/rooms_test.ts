// Integration: real server, real WebSockets, the headless client of the smoke test.

import { assert, assertEquals } from "@std/assert";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import { MSG_AWARENESS } from "../src/shared/protocol.ts";
import { until, YClient } from "../src/server/yclient.ts";
import { sleep, startServer } from "./helpers.ts";

const opts = { sanitizeOps: false, sanitizeResources: false };
const h1Count = (s: string) => (s.match(/<h1>/g) ?? []).length;

Deno.test({
  name: "rooms: two clients get the starter once, edits and cursors cross over",
  ...opts,
  async fn() {
    const srv = await startServer();
    const a = new YClient(`${srv.ws}/ws/room-one`);
    const b = new YClient(`${srv.ws}/ws/room-one`);
    try {
      await Promise.all([a.ready(), b.ready()]);
      assertEquals(h1Count(a.text("html")), 1);
      assertEquals(a.text("html"), b.text("html"));
      assert(a.text("css").includes("font-family"));
      assert(a.text("js").includes("addEventListener"));
      a.doc.getText("css").insert(0, "/* from a */\n");
      await until(() => b.text("css").startsWith("/* from a */"), 3000, "edit reaches b");
      b.doc.getText("js").insert(0, "// from b\n");
      await until(() => a.text("js").startsWith("// from b"), 3000, "edit reaches a");
      a.awareness.setLocalStateField("user", { name: "Ada", color: "#237af3" });
      await until(
        () => [...b.awareness.getStates().values()].some((s) => s.user?.name === "Ada"),
        3000,
        "presence reaches b",
      );
      assertEquals(srv.rooms.stats().connections, 2);
    } finally {
      await a.close();
      await b.close();
      await srv.stop();
    }
  },
});

Deno.test({
  name: "rooms: a client leaving removes its cursor for the others",
  ...opts,
  async fn() {
    const srv = await startServer();
    const a = new YClient(`${srv.ws}/ws/room-leave`);
    const b = new YClient(`${srv.ws}/ws/room-leave`);
    try {
      await Promise.all([a.ready(), b.ready()]);
      a.awareness.setLocalStateField("user", { name: "Ada" });
      await until(() => b.awareness.getStates().has(a.doc.clientID), 3000, "presence");
      a.ws.close(); // abrupt: no awareness removal sent by the client itself
      await until(() => !b.awareness.getStates().has(a.doc.clientID), 3000, "server removes the cursor");
    } finally {
      await a.close();
      await b.close();
      await srv.stop();
    }
  },
});

Deno.test({
  name: "rooms: edits persist across a server restart",
  ...opts,
  async fn() {
    const srv = await startServer();
    const a = new YClient(`${srv.ws}/ws/persist-me`);
    await a.ready();
    a.doc.getText("html").insert(0, "<!-- kept -->");
    await sleep(100);
    await a.close();
    await until(
      () => {
        try {
          return Deno.statSync(`${srv.dataDir}/rooms/persist-me.ydoc`).size > 0;
        } catch {
          return false;
        }
      },
      3000,
      "saved when the last client left",
    );
    await srv.stop();

    const again = await startServer({ dataDir: srv.dataDir });
    const b = new YClient(`${again.ws}/ws/persist-me`);
    try {
      await b.ready();
      assert(b.text("html").startsWith("<!-- kept -->"));
      assertEquals(h1Count(b.text("html")), 1);
      assertEquals(again.store.stored, 1);
    } finally {
      await b.close();
      await again.stop();
    }
  },
});

Deno.test({
  name: "rooms: an unedited room is not stored, and a stale copy never duplicates the starter",
  ...opts,
  async fn() {
    const srv = await startServer({ graceMs: 20 });
    const a = new YClient(`${srv.ws}/ws/fresh-room`);
    await a.ready();
    const stale = Y.encodeStateAsUpdate(a.doc);
    await a.close();
    await until(() => srv.rooms.stats().live === 0, 3000, "room unloaded");
    assertEquals(await srv.store.exists("fresh-room"), false);
    // the room is re-seeded on the next open; a client that kept the old copy merges it
    const b = new YClient(`${srv.ws}/ws/fresh-room`);
    Y.applyUpdate(b.doc, stale);
    const c = new YClient(`${srv.ws}/ws/fresh-room`);
    try {
      await Promise.all([b.ready(), c.ready()]);
      await sleep(150);
      assertEquals(h1Count(b.text("html")), 1);
      assertEquals(h1Count(c.text("html")), 1);
      assertEquals(b.text("html"), c.text("html"));
    } finally {
      await b.close();
      await c.close();
      await srv.stop();
    }
  },
});

Deno.test({
  name: "limits: an edit over the room size is refused with a notice and not relayed",
  ...opts,
  async fn() {
    const srv = await startServer({ limits: { maxDocBytes: 16 * 1024 } });
    const a = new YClient(`${srv.ws}/ws/big-room`);
    const b = new YClient(`${srv.ws}/ws/big-room`);
    try {
      await Promise.all([a.ready(), b.ready()]);
      a.doc.getText("js").insert(0, "x".repeat(40_000));
      await until(() => a.notices.some((n) => n.code === "doc-too-large"), 3000, "notice");
      await sleep(100);
      assert(!b.text("js").startsWith("xxxx"), "oversized edit must not reach other clients");
    } finally {
      await a.close();
      await b.close();
      await srv.stop();
    }
  },
});

Deno.test({
  name: "limits: a full room refuses the next person",
  ...opts,
  async fn() {
    const srv = await startServer({ limits: { maxPeersPerRoom: 2 } });
    const a = new YClient(`${srv.ws}/ws/small-room`);
    const b = new YClient(`${srv.ws}/ws/small-room`);
    await Promise.all([a.ready(), b.ready()]);
    const c = new YClient(`${srv.ws}/ws/small-room`);
    try {
      await c.closed;
      assertEquals(c.notices[0]?.code, "room-full");
      await until(() => srv.rooms.stats().connections === 2, 3000, "refused connection released");
    } finally {
      await a.close();
      await b.close();
      await c.close();
      await srv.stop();
    }
  },
});

Deno.test({
  name: "limits: an undecodable message closes the connection",
  ...opts,
  async fn() {
    const srv = await startServer();
    const a = new YClient(`${srv.ws}/ws/bad-msgs`);
    try {
      await a.ready();
      a.sendRaw(new Uint8Array([99, 1, 2]));
      await a.closed;
      assertEquals(a.notices[0]?.code, "bad-message");
    } finally {
      await a.close();
      await srv.stop();
    }
  },
});

Deno.test({
  name: "limits: message flood is rate limited",
  ...opts,
  async fn() {
    const srv = await startServer({ limits: { msgBurst: 5, msgPerSecond: 1 } });
    const a = new YClient(`${srv.ws}/ws/flood-room`);
    try {
      await a.ready();
      for (let i = 0; i < 20; i++) {
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, MSG_AWARENESS);
        encoding.writeVarUint8Array(e, new Uint8Array([0])); // zero states: valid, no-op
        a.sendRaw(encoding.toUint8Array(e));
      }
      await a.closed;
      assert(a.notices.some((n) => n.code === "rate-limited"), JSON.stringify(a.notices));
    } finally {
      await a.close();
      await srv.stop();
    }
  },
});

Deno.test({
  name: "limits: new rooms per hour per address",
  ...opts,
  async fn() {
    const srv = await startServer({ limits: { newRoomsPerHour: 1 } });
    const a = new YClient(`${srv.ws}/ws/first-room`);
    await a.ready();
    const b = new YClient(`${srv.ws}/ws/second-room`);
    // an existing (live) room can still be joined
    const c = new YClient(`${srv.ws}/ws/first-room`);
    try {
      await b.closed;
      assertEquals(b.notices[0]?.code, "too-many-new-rooms");
      await c.ready();
    } finally {
      await a.close();
      await b.close();
      await c.close();
      await srv.stop();
    }
  },
});

Deno.test({
  name: "limits: connections per address",
  ...opts,
  async fn() {
    const srv = await startServer({ limits: { maxConnsPerIp: 2 } });
    const a = new YClient(`${srv.ws}/ws/conn-room`);
    const b = new YClient(`${srv.ws}/ws/conn-room`);
    await Promise.all([a.ready(), b.ready()]);
    const c = new YClient(`${srv.ws}/ws/conn-room`);
    try {
      await c.closed;
      assertEquals(c.notices[0]?.code, "server-full");
      await a.close();
      await until(() => srv.rooms.stats().connections === 1, 3000, "released");
      const d = new YClient(`${srv.ws}/ws/conn-room`);
      await d.ready();
      await d.close();
    } finally {
      await a.close();
      await b.close();
      await c.close();
      await srv.stop();
    }
  },
});

Deno.test({
  name: "store: gc deletes expired rooms (smoke rooms after an hour), keeps live ones",
  ...opts,
  async fn() {
    const srv = await startServer();
    try {
      await srv.store.save("old-room", new Uint8Array([0, 0]));
      await srv.store.save("smoke-abc123", new Uint8Array([0, 0]));
      await srv.store.save("live-room", new Uint8Array([0, 0]));
      await srv.store.save("new-room", new Uint8Array([0, 0]));
      const past = new Date(Date.now() - 91 * 86400_000);
      await Deno.utime(`${srv.dataDir}/rooms/old-room.ydoc`, past, past);
      await Deno.utime(`${srv.dataDir}/rooms/live-room.ydoc`, past, past);
      const hourAgo = new Date(Date.now() - 2 * 3600_000);
      await Deno.utime(`${srv.dataDir}/rooms/smoke-abc123.ydoc`, hourAgo, hourAgo);
      const n = await srv.store.gc(90, (id) => id === "live-room");
      assertEquals(n, 2);
      assertEquals(await srv.store.exists("old-room"), false);
      assertEquals(await srv.store.exists("smoke-abc123"), false);
      assertEquals(await srv.store.exists("live-room"), true);
      assertEquals(await srv.store.exists("new-room"), true);
      assertEquals(srv.store.stored, 2);
    } finally {
      await srv.stop();
    }
  },
});
