// Unit tests: network helpers, config, protocol ids, settings sanitising, palette matching.

import { assert, assertEquals, assertFalse } from "@std/assert";
import { clientIp, inCidr, originAllowed } from "../src/server/net.ts";
import { ENV_VARS, LIBRARY_ENV_VARS, loadConfig } from "../src/server/config.ts";
import { isRoomId, newRoomId } from "../src/shared/protocol.ts";
import { defaults, sanitize } from "../src/client/settings.ts";
import { fuzzyScore } from "../src/client/ui/palette.ts";

Deno.test("net: CIDR matching v4, v6 and mapped v4", () => {
  assert(inCidr("127.0.0.1", "127.0.0.0/8"));
  assert(inCidr("172.18.0.5", "172.16.0.0/12"));
  assertFalse(inCidr("172.32.0.1", "172.16.0.0/12"));
  assert(inCidr("::1", "::1/128"));
  assert(inCidr("::ffff:172.17.0.1", "172.16.0.0/12"));
  assert(inCidr("2001:db8::1", "2001:db8::/32"));
  assertFalse(inCidr("2001:db9::1", "2001:db8::/32"));
  assertFalse(inCidr("garbage", "127.0.0.0/8"));
});

Deno.test("net: X-Forwarded-For only from trusted proxies, right-most untrusted hop", () => {
  const trusted = ["127.0.0.0/8", "::1/128", "172.16.0.0/12"];
  assertEquals(clientIp("172.17.0.1", "203.0.113.7", trusted), "203.0.113.7");
  assertEquals(clientIp("172.17.0.1", "1.1.1.1, 203.0.113.7", trusted), "203.0.113.7");
  assertEquals(clientIp("172.17.0.1", "203.0.113.7, 127.0.0.1", trusted), "203.0.113.7");
  assertEquals(clientIp("198.51.100.2", "203.0.113.7", trusted), "198.51.100.2"); // spoof from outside
  assertEquals(clientIp("::ffff:172.17.0.1", null, trusted), "172.17.0.1");
});

Deno.test("net: websocket origin check", () => {
  assert(originAllowed(null, "https://code.hosh.it", "http://code.hosh.it/ws/x"));
  assert(originAllowed("https://code.hosh.it", "https://code.hosh.it", "http://code.hosh.it/ws/x"));
  assert(originAllowed("http://127.0.0.1:1234", "https://code.hosh.it", "http://127.0.0.1:1234/ws/x"));
  assertFalse(originAllowed("https://evil.example", "https://code.hosh.it", "http://code.hosh.it/ws/x"));
  assertFalse(originAllowed("null", "https://code.hosh.it", "http://code.hosh.it/ws/x"));
});

Deno.test("config: defaults are the box values, bad numbers fall back, env list = compiled --allow-env", async () => {
  const c = loadConfig(() => undefined);
  assertEquals(c.port, 8000);
  assertEquals(c.dataDir, "/data");
  assertEquals(c.baseUrl, "https://code.hosh.it");
  assertEquals(c.trustedProxies, ["127.0.0.0/8", "::1/128", "172.16.0.0/12"]);
  assertEquals(c.limits.maxDocBytes, 640 * 1024);
  assertEquals(c.limits.maxFileChars, 128 * 1024);
  assertEquals(c.limits.roomTtlDays, 7);
  const env: Record<string, string> = {
    LIVECODE_MAX_DOC_KB: "-5",
    LIVECODE_MAX_PEERS_PER_ROOM: "abc",
    APP_BASE_URL: "https://x.test/",
  };
  const d = loadConfig((k) => env[k]);
  assertEquals(d.limits.maxDocBytes, 640 * 1024);
  assertEquals(d.limits.maxPeersPerRoom, 32);
  assertEquals(d.baseUrl, "https://x.test");
  const deno = JSON.parse(await Deno.readTextFile(new URL("../deno.json", import.meta.url)));
  const allow = (deno.tasks.compile as string).match(/--allow-env=(\S+)/)![1].split(",");
  assertEquals([...allow].sort(), [...ENV_VARS, ...LIBRARY_ENV_VARS].sort());
});

Deno.test("protocol: room ids", () => {
  for (const ok of ["abcd", "my-room", "a1b2-c3", newRoomId()]) assert(isRoomId(ok), ok);
  for (const bad of ["abc", "ABCD", "-abcd", "abcd-", "ab--cd", "a".repeat(41), "a/b/c/d", "ab cd", "..ab"]) {
    assertFalse(isRoomId(bad), bad);
  }
  const ids = new Set(Array.from({ length: 200 }, newRoomId));
  assertEquals(ids.size, 200);
  for (const id of ids) assertEquals(id.length, 12);
});

Deno.test("settings: sanitize keeps valid values, drops junk", () => {
  const base = defaults();
  const s = sanitize({
    name: "  Ada  ",
    color: "#237af3",
    theme: "hc-dark",
    keymap: "vim",
    fontSize: 99,
    previewDelay: 50,
    overrides: { vim: { run: ["Mod-r"], bad: "x" }, nope: { run: ["x"] } },
    layout: "diagonal",
  }, base);
  assertEquals(s.name, "Ada");
  assertEquals(s.color, "#237af3");
  assertEquals(s.theme, "hc-dark");
  assertEquals(s.keymap, "vim");
  assertEquals(s.fontSize, base.fontSize);
  assertEquals(s.previewDelay, base.previewDelay);
  assertEquals(s.overrides, { vim: { run: ["Mod-r"] } });
  assertEquals(s.layout, base.layout);
  const junk = sanitize("not an object", base);
  assertEquals(junk.keymap, "vscode");
  assertEquals(sanitize({ color: "red" }, base).color, base.color);
});

Deno.test("palette: fuzzy matching ranks word starts and runs", () => {
  assertEquals(fuzzyScore("", "anything"), 0);
  assertEquals(fuzzyScore("xyz", "Run preview now"), null);
  assert(fuzzyScore("run prev", "Preview: Run preview now") !== null);
  const a = fuzzyScore("theme dark", "Theme: Dark")!;
  const b = fuzzyScore("theme dark", "Theme: Solarized dark")!;
  assert(a > b, `${a} > ${b}`);
  assert(fuzzyScore("hcd", "Theme: High contrast dark") !== null);
});
