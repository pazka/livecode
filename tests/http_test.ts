// HTTP surface: routes, security headers, the WebSocket gate.

import { assert, assertEquals, assertMatch } from "@std/assert";
import { startServer } from "./helpers.ts";

const opts = { sanitizeOps: false, sanitizeResources: false };

Deno.test({
  name: "http: pages, assets, headers",
  ...opts,
  async fn() {
    const srv = await startServer();
    try {
      const home = await fetch(`${srv.base}/`);
      assertEquals(home.status, 200);
      await home.text();
      const csp = home.headers.get("content-security-policy") ?? "";
      for (const d of ["default-src 'self'", "script-src 'self'", "frame-ancestors 'none'", "object-src 'none'"]) {
        assert(csp.includes(d), `CSP lacks ${d}: ${csp}`);
      }
      assertEquals(home.headers.get("x-frame-options"), "DENY");
      assertEquals(home.headers.get("referrer-policy"), "no-referrer");
      assertEquals(home.headers.get("x-content-type-options"), "nosniff");

      const room = await fetch(`${srv.base}/r/my-room`);
      assertEquals(room.status, 200);
      assert((await room.text()).includes('id="app"'));

      for (const bad of ["/r/AB", "/r/x", "/r/-abc", "/r/abc--def", "/r/a_b_c", "/.env", "/.git/config", "/nope"]) {
        const r = await fetch(`${srv.base}${bad}`);
        await r.body?.cancel();
        assertEquals(r.status, 404, bad);
      }

      const js = await fetch(`${srv.base}/app.js?v=abc123`, { headers: { "accept-encoding": "identity" } });
      await js.body?.cancel();
      assertEquals(js.status, 200);
      assertMatch(js.headers.get("cache-control") ?? "", /immutable/);

      const post = await fetch(`${srv.base}/`, { method: "POST", body: "x" });
      await post.body?.cancel();
      assertEquals(post.status, 405);

      const head = await fetch(`${srv.base}/r/my-room`, { method: "HEAD" });
      assertEquals(head.status, 200);
      assertEquals(await head.text(), "");

      const robots = await fetch(`${srv.base}/robots.txt`);
      assert((await robots.text()).includes("Disallow: /r/"));
    } finally {
      await srv.stop();
    }
  },
});

Deno.test({
  name: "http: /new redirects to a fresh 12-character room",
  ...opts,
  async fn() {
    const srv = await startServer();
    try {
      const ids = new Set<string>();
      for (let i = 0; i < 5; i++) {
        const r = await fetch(`${srv.base}/new`, { redirect: "manual" });
        await r.body?.cancel();
        assertEquals(r.status, 303);
        const loc = r.headers.get("location") ?? "";
        assertMatch(loc, /^\/r\/[a-z2-9]{12}$/);
        ids.add(loc);
      }
      assertEquals(ids.size, 5);
    } finally {
      await srv.stop();
    }
  },
});

Deno.test({
  name: "http: the preview frame has its own permissive-but-contained policy",
  ...opts,
  async fn() {
    const srv = await startServer();
    try {
      const r = await fetch(`${srv.base}/preview`);
      assertEquals(r.status, 200);
      assert((await r.text()).includes("/preview.js"));
      const csp = r.headers.get("content-security-policy") ?? "";
      assert(csp.includes("'unsafe-inline'") && csp.includes("form-action 'none'") && csp.includes("frame-ancestors 'self'"));
      assertEquals(r.headers.get("x-frame-options"), "SAMEORIGIN");
      const js = await fetch(`${srv.base}/preview.js?v=1`);
      await js.body?.cancel();
      // loaded by an opaque-origin (sandboxed) document: must not be same-origin only
      assertEquals(js.headers.get("cross-origin-resource-policy"), "cross-origin");
    } finally {
      await srv.stop();
    }
  },
});

Deno.test({
  name: "http: healthz proves the data volume is writable",
  ...opts,
  async fn() {
    const srv = await startServer();
    try {
      const r = await fetch(`${srv.base}/healthz`);
      const h = await r.json();
      assertEquals(r.status, 200);
      assertEquals(h.status, "ok");
      assertEquals(h.storage, "writable");
      assertEquals(h.version, "test");
      assertEquals(typeof h.rooms.stored, "number");
      assertEquals(r.headers.get("cache-control"), "no-store");
    } finally {
      await srv.stop();
    }
  },
});

Deno.test({
  name: "http: websocket gate — upgrade required, foreign origins refused, bad ids 404",
  ...opts,
  async fn() {
    const srv = await startServer();
    try {
      const plain = await fetch(`${srv.base}/ws/some-room`);
      await plain.body?.cancel();
      assertEquals(plain.status, 426);
      const upgradeHeaders = {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      };
      const evil = await fetch(`${srv.base}/ws/some-room`, {
        headers: { ...upgradeHeaders, origin: "https://evil.example" },
      });
      await evil.body?.cancel();
      assertEquals(evil.status, 403);
      const badId = await fetch(`${srv.base}/ws/NOPE`, { headers: upgradeHeaders });
      await badId.body?.cancel();
      assertEquals(badId.status, 404);
    } finally {
      await srv.stop();
    }
  },
});
