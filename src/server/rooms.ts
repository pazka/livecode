// Rooms: one Y.Doc (files html/css/js) + one Awareness (cursors, names) per room, shared by every
// connection of the room. Speaks the y-websocket wire convention (shared/protocol.ts) with limits:
// document size, peers per room, message size and rate, connections per address, new rooms per hour.

import * as Y from "yjs";
import * as sync from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import {
  CLOSE_FULL,
  CLOSE_POLICY,
  FILES,
  MSG_AWARENESS,
  MSG_NOTICE,
  MSG_SYNC,
  type Notice,
  type NoticeCode,
} from "../shared/protocol.ts";
import { STARTER } from "../shared/starter.ts";
import type { Limits } from "./config.ts";
import { log, roomTag } from "./log.ts";
import type { Store } from "./store.ts";

export interface Conn {
  readonly ip: string;
  send(data: Uint8Array): void;
  close(code: number, reason: string): void;
}

interface ConnState {
  /** Awareness client ids this connection controls (removed when it leaves). */
  ids: Set<number>;
  tokens: number;
  refilledAt: number;
}

const MAX_AWARENESS_BYTES = 16 * 1024;
const MAX_IDS_PER_CONN = 4;

/**
 * The starter files as one Yjs update written by a fixed client id: applying it to any fresh room gives the
 * same items, so a client that kept an old copy of a never-saved room merges it without duplicating it.
 */
export const SEED_UPDATE: Uint8Array = (() => {
  const d = new Y.Doc();
  d.clientID = 1;
  d.transact(() => {
    for (const f of FILES) d.getText(f).insert(0, STARTER[f]);
  });
  const u = Y.encodeStateAsUpdate(d);
  d.destroy();
  return u;
})();

export function encodeNotice(code: NoticeCode, message: string): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_NOTICE);
  encoding.writeVarString(enc, JSON.stringify({ code, message } satisfies Notice));
  return encoding.toUint8Array(enc);
}

export class Room {
  readonly doc = new Y.Doc({ gc: true });
  readonly awareness: awarenessProtocol.Awareness;
  readonly conns = new Map<Conn, ConnState>();
  /** Approximate encoded size (exact after each save, + incoming update sizes in between). */
  bytes: number;
  /** Size limit reached: updates are refused until the document shrinks (deletions, then a save). */
  full = false;
  dirty = false;
  destroyed = false;
  saved: boolean;
  unloadTimer: number | undefined;
  private saveTimer: number | undefined;
  private firstDirtyAt = 0;
  private saving: Promise<void> | null = null;

  constructor(
    readonly id: string,
    private readonly store: Store,
    private readonly limits: Limits,
    initial: Uint8Array | null,
  ) {
    Y.applyUpdate(this.doc, initial ?? SEED_UPDATE, "load");
    this.saved = initial !== null;
    this.bytes = initial?.length ?? SEED_UPDATE.length;
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.awareness.setLocalState(null); // the server has no cursor
    this.doc.on("update", (update: Uint8Array, origin: unknown) => this.onUpdate(update, origin));
    this.awareness.on(
      "update",
      (ch: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) =>
        this.onAwareness(ch, origin),
    );
  }

  get peers(): number {
    return this.conns.size;
  }

  private broadcast(data: Uint8Array, except?: unknown) {
    for (const c of this.conns.keys()) if (c !== except) c.send(data);
  }

  private onUpdate(update: Uint8Array, origin: unknown) {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    sync.writeUpdate(enc, update);
    this.broadcast(encoding.toUint8Array(enc), origin);
    if (origin === "load") return;
    if (!this.dirty) this.firstDirtyAt = Date.now();
    this.dirty = true;
    this.scheduleSave();
  }

  private onAwareness(ch: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) {
    const st = this.conns.get(origin as Conn);
    if (st) {
      for (const id of ch.added) st.ids.add(id);
      for (const id of ch.removed) st.ids.delete(id);
    }
    const changed = ch.added.concat(ch.updated, ch.removed);
    if (changed.length === 0) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
    this.broadcast(encoding.toUint8Array(enc), origin);
  }

  /** Debounced: 2 s after the last edit, at most 10 s after the first unsaved one. */
  private scheduleSave() {
    clearTimeout(this.saveTimer);
    const wait = Math.max(0, Math.min(2000, this.firstDirtyAt + 10_000 - Date.now()));
    this.saveTimer = setTimeout(() => void this.save(), wait);
  }

  async save(): Promise<void> {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (this.saving) await this.saving;
    if (!this.dirty) return;
    this.dirty = false;
    const state = Y.encodeStateAsUpdate(this.doc);
    this.bytes = state.length;
    if (this.full && this.bytes <= this.limits.maxDocBytes) this.full = false;
    this.saving = this.store.save(this.id, state).then(
      () => {
        this.saved = true;
      },
      (e) => {
        log("error", "room save failed", { room: roomTag(this.id), error: String(e) });
        this.dirty = true;
        this.saveTimer = setTimeout(() => void this.save(), 5000);
      },
    ).finally(() => {
      this.saving = null;
    });
    await this.saving;
  }

  join(conn: Conn): boolean {
    if (this.conns.size >= this.limits.maxPeersPerRoom) {
      conn.send(encodeNotice("room-full", `This room is full (${this.limits.maxPeersPerRoom} people).`));
      conn.close(CLOSE_FULL, "room full");
      return false;
    }
    clearTimeout(this.unloadTimer);
    this.unloadTimer = undefined;
    this.conns.set(conn, { ids: new Set(), tokens: this.limits.msgBurst, refilledAt: Date.now() });
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    sync.writeSyncStep1(enc, this.doc);
    conn.send(encoding.toUint8Array(enc));
    const states = this.awareness.getStates();
    if (states.size > 0) {
      const a = encoding.createEncoder();
      encoding.writeVarUint(a, MSG_AWARENESS);
      encoding.writeVarUint8Array(
        a,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...states.keys()]),
      );
      conn.send(encoding.toUint8Array(a));
    }
    if (this.full) {
      conn.send(encodeNotice("doc-too-large", "This room reached its size limit: new edits are not saved."));
    }
    return true;
  }

  /** Removes the connection; true when the room is now empty. */
  leave(conn: Conn): boolean {
    const st = this.conns.get(conn);
    if (!st) return this.conns.size === 0;
    this.conns.delete(conn);
    if (st.ids.size > 0) awarenessProtocol.removeAwarenessStates(this.awareness, [...st.ids], null);
    return this.conns.size === 0;
  }

  private refuse(conn: Conn, code: NoticeCode, message: string) {
    conn.send(encodeNotice(code, message));
    conn.close(CLOSE_POLICY, code);
  }

  handle(conn: Conn, data: Uint8Array): void {
    const st = this.conns.get(conn);
    if (!st) return;
    const now = Date.now();
    st.tokens = Math.min(
      this.limits.msgBurst,
      st.tokens + ((now - st.refilledAt) / 1000) * this.limits.msgPerSecond,
    );
    st.refilledAt = now;
    if (st.tokens < 1) return this.refuse(conn, "rate-limited", "Too many messages: reconnecting.");
    st.tokens -= 1;
    if (data.length > this.limits.maxMessageBytes) {
      return this.refuse(conn, "bad-message", "Message too large.");
    }
    try {
      const dec = decoding.createDecoder(data);
      const type = decoding.readVarUint(dec);
      if (type === MSG_SYNC) {
        const sub = decoding.readVarUint(dec);
        if (sub === sync.messageYjsSyncStep1) {
          const sv = decoding.readVarUint8Array(dec);
          const enc = encoding.createEncoder();
          encoding.writeVarUint(enc, MSG_SYNC);
          sync.writeSyncStep2(enc, this.doc, sv);
          conn.send(encoding.toUint8Array(enc));
        } else if (sub === sync.messageYjsSyncStep2 || sub === sync.messageYjsUpdate) {
          const upd = decoding.readVarUint8Array(dec);
          if (!this.accepts(upd.length)) {
            conn.send(
              encodeNotice(
                "doc-too-large",
                "This room reached its size limit: your last edits were not saved.",
              ),
            );
            return;
          }
          Y.applyUpdate(this.doc, upd, conn);
          this.bytes += upd.length;
          this.enforceFileLimit(conn);
        } else {
          return this.refuse(conn, "bad-message", "Unknown sync message.");
        }
      } else if (type === MSG_AWARENESS) {
        const upd = decoding.readVarUint8Array(dec);
        if (upd.length > MAX_AWARENESS_BYTES) {
          return this.refuse(conn, "bad-message", "Presence message too large.");
        }
        awarenessProtocol.applyAwarenessUpdate(this.awareness, upd, conn);
        if (st.ids.size > MAX_IDS_PER_CONN) return this.refuse(conn, "bad-message", "Too many presence ids.");
      } else {
        return this.refuse(conn, "bad-message", "Unknown message type.");
      }
    } catch {
      return this.refuse(conn, "bad-message", "Undecodable message.");
    }
  }

  /**
   * Per-file limit: a file longer than maxFileChars is cut back by the server (a normal edit, so every client
   * converges on it). The editor refuses such input itself; only a modified client ever gets here.
   */
  private enforceFileLimit(conn: Conn) {
    const max = this.limits.maxFileChars;
    const over = FILES.filter((f) => this.doc.getText(f).length > max);
    if (over.length === 0) return;
    this.doc.transact(() => {
      for (const f of over) {
        const t = this.doc.getText(f);
        t.delete(max, t.length - max);
      }
    }, "limit");
    conn.send(encodeNotice(
      "file-too-large",
      `${over.map((f) => f.toUpperCase()).join(", ")} is over the limit of ${Math.round(max / 1024)} K characters: cut back.`,
    ));
  }

  /** Size gate. The running estimate only grows; recompute exactly before refusing anything. */
  private accepts(len: number): boolean {
    const max = this.limits.maxDocBytes;
    if (!this.full && this.bytes + len <= max) return true;
    this.bytes = Y.encodeStateAsUpdate(this.doc).length;
    // once full, small edits (typically deletions) still pass up to 10 % over the limit
    if (this.bytes + len <= max || (len <= 512 && this.bytes + len <= max * 1.1)) {
      this.full = this.bytes > max;
      return true;
    }
    this.full = true;
    return false;
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.saveTimer);
    clearTimeout(this.unloadTimer);
    this.awareness.destroy();
    this.doc.destroy();
  }
}

export interface Stats {
  live: number;
  stored: number;
  connections: number;
}

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  private readonly loading = new Map<string, Promise<Room | Notice>>();
  private readonly perIp = new Map<string, number>();
  private readonly created = new Map<string, number[]>();
  private total = 0;
  private gcTimer: number | undefined;

  constructor(readonly store: Store, readonly limits: Limits, readonly unloadGraceMs = 30_000) {}

  stats(): Stats {
    return { live: this.rooms.size, stored: this.store.stored, connections: this.total };
  }

  /** Connection-level admission (before the room is touched). Returns a refusal or null. */
  admit(conn: Conn): Notice | null {
    if (this.overMemory()) {
      return { code: "server-full", message: "The server is busy: try again in a minute." };
    }
    if (this.total >= this.limits.maxConns) {
      return { code: "server-full", message: "The server is at capacity: try again later." };
    }
    if ((this.perIp.get(conn.ip) ?? 0) >= this.limits.maxConnsPerIp) {
      return { code: "server-full", message: "Too many open connections from your address." };
    }
    this.total++;
    this.perIp.set(conn.ip, (this.perIp.get(conn.ip) ?? 0) + 1);
    return null;
  }

  release(conn: Conn) {
    this.total = Math.max(0, this.total - 1);
    const n = (this.perIp.get(conn.ip) ?? 1) - 1;
    if (n <= 0) this.perIp.delete(conn.ip);
    else this.perIp.set(conn.ip, n);
  }

  /** Process memory above the guard (Deno.memoryUsage is cheap; cached for a second). */
  private rssAt = 0;
  private rss = 0;
  overMemory(): boolean {
    const now = Date.now();
    if (now - this.rssAt > 1000) {
      this.rssAt = now;
      try {
        this.rss = Deno.memoryUsage().rss;
      } catch {
        this.rss = 0;
      }
    }
    return this.rss > this.limits.maxRssBytes;
  }

  private createdTotal: number[] = [];

  private unsavedLive(): number {
    let n = 0;
    for (const r of this.rooms.values()) if (!r.saved) n++;
    return n;
  }

  /** Opens (loads or creates) a room for this connection; a refusal when a limit says no. */
  open(id: string, ip: string): Promise<Room | Notice> {
    const live = this.rooms.get(id);
    if (live) return Promise.resolve(live);
    // single flight: concurrent joins of a room that is not in memory share one load
    let p = this.loading.get(id);
    if (!p) {
      p = this.load(id, ip).finally(() => this.loading.delete(id));
      this.loading.set(id, p);
    }
    return p;
  }

  private async load(id: string, ip: string): Promise<Room | Notice> {
    if (this.rooms.size >= this.limits.maxLiveRooms || this.overMemory()) {
      return { code: "server-full", message: "Too many rooms are open right now: try again in a minute." };
    }
    const data = await this.store.load(id);
    if (data === null) {
      if (
        this.store.stored + this.unsavedLive() >= this.limits.maxRooms ||
        this.store.bytes >= this.limits.maxStorageBytes
      ) {
        return { code: "server-full", message: "No new rooms can be created right now." };
      }
      const now = Date.now();
      const recent = (this.created.get(ip) ?? []).filter((t) => now - t < 3600_000);
      if (recent.length >= this.limits.newRoomsPerHour) {
        return { code: "too-many-new-rooms", message: "Too many new rooms from your address: try later." };
      }
      this.createdTotal = this.createdTotal.filter((t) => now - t < 3600_000);
      if (this.createdTotal.length >= this.limits.newRoomsPerHourTotal) {
        return { code: "too-many-new-rooms", message: "Too many new rooms right now: try later." };
      }
      recent.push(now);
      this.created.set(ip, recent);
      this.createdTotal.push(now);
    } else {
      await this.store.touch(id);
    }
    const room = new Room(id, this.store, this.limits, data);
    this.rooms.set(id, room);
    log("info", "room open", { room: roomTag(id), stored: data !== null, bytes: room.bytes });
    return room;
  }

  /**
   * Opens the room and joins it. Returns the room, a refusal (not sent yet), or null when the room itself
   * refused the connection (it already sent the notice and closed it).
   */
  async join(id: string, conn: Conn): Promise<Room | Notice | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await this.open(id, conn.ip);
      if (!(r instanceof Room)) return r;
      if (r.destroyed) continue; // unloaded between open and join: open again
      return r.join(conn) ? r : null;
    }
    return { code: "server-full", message: "Room is busy: try again." };
  }

  /** The connection left the room: save at once when it was the last one, unload after a grace period. */
  async leave(room: Room, conn: Conn): Promise<void> {
    if (!room.leave(conn)) return;
    await room.save();
    clearTimeout(room.unloadTimer);
    room.unloadTimer = setTimeout(() => void this.unload(room), this.unloadGraceMs);
  }

  private async unload(room: Room) {
    if (room.peers > 0 || this.rooms.get(room.id) !== room) return;
    await room.save();
    if (room.peers > 0) return;
    // the idle TTL counts from the moment the last person left
    if (room.saved) await this.store.touch(room.id);
    this.rooms.delete(room.id);
    room.destroy();
    log("debug", "room unloaded", { room: roomTag(room.id) });
  }

  async gc(): Promise<number> {
    const n = await this.store.gc(this.limits.roomTtlDays, (id) => this.rooms.has(id));
    // forget creation timestamps older than an hour
    const now = Date.now();
    for (const [ip, ts] of this.created) {
      const keep = ts.filter((t) => now - t < 3600_000);
      if (keep.length) this.created.set(ip, keep);
      else this.created.delete(ip);
    }
    if (n) log("info", "rooms expired", { deleted: n });
    return n;
  }

  startGc(everyMs = 6 * 3600_000) {
    void this.gc().catch((e) => log("error", "gc failed", { error: String(e) }));
    this.gcTimer = setInterval(
      () => void this.gc().catch((e) => log("error", "gc failed", { error: String(e) })),
      everyMs,
    );
  }

  /** Save everything (shutdown) and free every room. */
  async close(): Promise<void> {
    clearInterval(this.gcTimer);
    for (const r of this.rooms.values()) await r.save();
    for (const r of this.rooms.values()) r.destroy();
    this.rooms.clear();
  }
}
