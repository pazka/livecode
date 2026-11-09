// HTTP surface: the embedded front-end (/, /r/<room>), /new, the preview frame, /healthz, and the room
// WebSocket /ws/<room>. HEAD is answered like GET.

import { CLOSE_FULL, isRoomId, newRoomId } from "../shared/protocol.ts";
import type { Config } from "./config.ts";
import { log } from "./log.ts";
import { clientIp, originAllowed } from "./net.ts";
import { type Conn, encodeNotice, type Room, type RoomManager } from "./rooms.ts";

export interface Asset {
  type: string;
  /** Absent for a large asset kept gzipped only (the TypeScript worker): inflated for the rare client without gzip. */
  body?: Uint8Array<ArrayBuffer>;
  gzip?: Uint8Array<ArrayBuffer>;
  /** Long-lived cache for fingerprinted files; html is always revalidated. */
  immutable: boolean;
}

/** The editor app. Styles need 'unsafe-inline': CodeMirror and the shared cursors set style attributes. */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src 'self'",
  "worker-src 'self'", // the TypeScript worker (/ts-worker.js)
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * The preview frame runs the room's own code. It is loaded in an iframe sandboxed WITHOUT allow-same-origin
 * (opaque origin: no access to this site's storage, cookies or the editor), so it may load what a page
 * normally loads (CDN scripts, images, fetch). It can't submit forms or be framed by another site.
 */
export const PREVIEW_CSP = [
  "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

const BASE_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=()",
};

const APP_HEADERS: Record<string, string> = {
  ...BASE_HEADERS,
  "content-security-policy": CSP,
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};

const PREVIEW_HEADERS: Record<string, string> = {
  ...BASE_HEADERS,
  "content-security-policy": PREVIEW_CSP,
  "x-frame-options": "SAMEORIGIN",
  // fetched by an opaque-origin (sandboxed) document: same-origin would block it
  "cross-origin-resource-policy": "cross-origin",
};

const ROBOTS = "User-agent: *\nDisallow: /r/\nDisallow: /new\n";

function respond(body: BodyInit | null, status: number, headers: Record<string, string>, head: boolean) {
  return new Response(head ? null : body, { status, headers });
}

const text = (s: string, status: number, head: boolean, extra: Record<string, string> = {}) =>
  respond(s, status, { ...APP_HEADERS, "content-type": "text/plain; charset=utf-8", ...extra }, head);

const json = (v: unknown, status: number, head: boolean) =>
  respond(JSON.stringify(v), status, {
    ...APP_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  }, head);

function serveAsset(req: Request, a: Asset, headers: Record<string, string>, head: boolean): Response {
  const h: Record<string, string> = {
    ...headers,
    "content-type": a.type,
    "cache-control": a.immutable ? "public, max-age=31536000, immutable" : "no-cache",
    vary: "accept-encoding",
  };
  const gz = a.gzip && /\bgzip\b/.test(req.headers.get("accept-encoding") ?? "");
  if (gz) h["content-encoding"] = "gzip";
  if (gz || a.body) return respond(gz ? a.gzip! : a.body!, 200, h, head);
  const inflated = new Blob([a.gzip!]).stream().pipeThrough(new DecompressionStream("gzip"));
  return respond(inflated, 200, h, head);
}

export interface Deps {
  cfg: Config;
  rooms: RoomManager;
  assets: Map<string, Asset>;
  startedAt?: number;
}

export function makeHandler(deps: Deps) {
  const startedAt = deps.startedAt ?? Date.now();
  return async (req: Request, info: Deno.ServeHandlerInfo<Deno.NetAddr>): Promise<Response> => {
    const t0 = performance.now();
    const url = new URL(req.url);
    let res: Response;
    try {
      res = await route(req, url, info, deps, startedAt);
    } catch (e) {
      log("error", "handler error", {
        path: url.pathname.slice(0, 64),
        error: e instanceof Error ? e.name : "error",
      });
      res = json({ error: "internal" }, 500, false);
    }
    if (url.pathname !== "/healthz" && res.status !== 101) {
      log("debug", "req", {
        method: req.method,
        path: url.pathname.startsWith("/r/") ? "/r/:room" : url.pathname.slice(0, 64),
        status: res.status,
        ms: Math.round(performance.now() - t0),
      });
    }
    return res;
  };
}

async function route(
  req: Request,
  url: URL,
  info: Deno.ServeHandlerInfo<Deno.NetAddr>,
  deps: Deps,
  startedAt: number,
): Promise<Response> {
  const { cfg, rooms, assets } = deps;
  const head = req.method === "HEAD";
  const path = url.pathname;

  if (path.startsWith("/ws/")) return upgrade(req, url, info, deps, path.slice(4));

  if (req.method !== "GET" && !head) return text("method not allowed", 405, false, { allow: "GET, HEAD" });
  // Dotfiles and traversal never resolve (the edge blocks them too).
  if (path.split("/").some((seg) => seg.startsWith(".")) || path.includes("..")) {
    return text("not found", 404, head);
  }

  if (path === "/healthz") {
    const writable = await rooms.store.probe();
    const s = rooms.stats();
    return json(
      {
        status: writable ? "ok" : "degraded",
        version: cfg.version,
        storage: writable ? "writable" : "error",
        rooms: { live: s.live, stored: s.stored },
        connections: s.connections,
        uptime_s: Math.round((Date.now() - startedAt) / 1000),
      },
      writable ? 200 : 503,
      head,
    );
  }
  if (path === "/robots.txt") return text(ROBOTS, 200, head, { "cache-control": "public, max-age=86400" });
  if (path === "/new") {
    return respond(
      null,
      303,
      { ...APP_HEADERS, location: `/r/${newRoomId()}`, "cache-control": "no-store" },
      head,
    );
  }
  if (path === "/preview") {
    const a = assets.get("/preview.html");
    return a ? serveAsset(req, a, PREVIEW_HEADERS, head) : text("not found", 404, head);
  }
  if (path === "/preview.js") {
    const a = assets.get("/preview.js");
    return a ? serveAsset(req, a, PREVIEW_HEADERS, head) : text("not found", 404, head);
  }
  if (path === "/" || path.startsWith("/r/")) {
    // /r/<room> (the editor) and /r/<room>/view (the preview screen): the same page
    if (path !== "/" && !isRoomId(path.slice(3).replace(/\/view$/, ""))) {
      return text("not found: room names are a-z, 0-9 and -", 404, head);
    }
    const a = assets.get("/index.html");
    return a ? serveAsset(req, a, APP_HEADERS, head) : text("not built", 503, head);
  }
  const asset = assets.get(path);
  if (asset && path !== "/index.html" && path !== "/preview.html") {
    return serveAsset(req, asset, APP_HEADERS, head);
  }
  return text("not found", 404, head);
}

function upgrade(
  req: Request,
  url: URL,
  info: Deno.ServeHandlerInfo<Deno.NetAddr>,
  deps: Deps,
  id: string,
): Response {
  const { cfg, rooms } = deps;
  if (!isRoomId(id)) return text("not found", 404, false);
  if ((req.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
    return text("websocket upgrade required", 426, false, { upgrade: "websocket" });
  }
  if (!originAllowed(req.headers.get("origin"), cfg.baseUrl, url.href)) {
    return text("forbidden origin", 403, false);
  }

  const ip = clientIp(info.remoteAddr.hostname, req.headers.get("x-forwarded-for"), cfg.trustedProxies);
  const { socket, response } = Deno.upgradeWebSocket(req, { idleTimeout: 30 });
  socket.binaryType = "arraybuffer";
  const conn: Conn = {
    ip,
    send(d) {
      if (socket.readyState === WebSocket.OPEN) socket.send(d as Uint8Array<ArrayBuffer>);
    },
    close(code, reason) {
      try {
        socket.close(code, reason);
      } catch { /* already closing */ }
    },
  };
  let room: Room | null = null;
  let admitted = false;
  let closed = false;
  const early: Uint8Array[] = [];

  socket.onopen = async () => {
    const refused = rooms.admit(conn);
    if (refused) {
      conn.send(encodeNotice(refused.code, refused.message));
      conn.close(CLOSE_FULL, refused.code);
      return;
    }
    admitted = true;
    try {
      const r = await rooms.join(id, conn);
      if (r === null) return; // the room refused and closed it
      if (!("handle" in r)) {
        conn.send(encodeNotice(r.code, r.message));
        conn.close(CLOSE_FULL, r.code);
        return;
      }
      room = r;
      if (closed) {
        await rooms.leave(r, conn);
        return;
      }
      for (const m of early.splice(0)) r.handle(conn, m);
    } catch (e) {
      log("error", "join failed", { error: String(e) });
      conn.close(1011, "internal error");
    }
  };
  socket.onmessage = (e: MessageEvent) => {
    if (!(e.data instanceof ArrayBuffer)) return conn.close(1003, "binary only");
    const d = new Uint8Array(e.data);
    if (room) room.handle(conn, d);
    else if (early.length < 32) early.push(d);
    else conn.close(1008, "too early");
  };
  socket.onclose = () => {
    closed = true;
    if (admitted) rooms.release(conn);
    if (room) void rooms.leave(room, conn).catch((e) => log("error", "leave failed", { error: String(e) }));
  };
  socket.onerror = () => {/* onclose follows */};
  return response;
}
