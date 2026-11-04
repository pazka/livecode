// Rooms on disk: /data/rooms/<id>.ydoc = Y.encodeStateAsUpdate(doc). Atomic writes (temp file + rename).
// Room ids are validated (protocol.isRoomId) before they ever reach a path here.

import { isRoomId } from "../shared/protocol.ts";

export class Store {
  readonly roomsDir: string;
  private count = 0;

  constructor(readonly dataDir: string) {
    this.roomsDir = `${dataDir}/rooms`;
  }

  async init(): Promise<void> {
    await Deno.mkdir(this.roomsDir, { recursive: true });
    this.count = 0;
    for await (const e of Deno.readDir(this.roomsDir)) {
      if (e.isFile && e.name.endsWith(".ydoc")) this.count++;
      // a crash between write and rename leaves a temp file: drop it
      if (e.isFile && e.name.endsWith(".tmp")) {
        await Deno.remove(`${this.roomsDir}/${e.name}`).catch(() => {});
      }
    }
  }

  /** Rooms stored on disk (kept up to date by save/remove/gc). */
  get stored(): number {
    return this.count;
  }

  private path(id: string): string {
    if (!isRoomId(id)) throw new Error("bad room id");
    return `${this.roomsDir}/${id}.ydoc`;
  }

  async load(id: string): Promise<Uint8Array | null> {
    try {
      return await Deno.readFile(this.path(id));
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return null;
      throw e;
    }
  }

  async exists(id: string): Promise<boolean> {
    try {
      await Deno.stat(this.path(id));
      return true;
    } catch {
      return false;
    }
  }

  async save(id: string, state: Uint8Array): Promise<void> {
    const p = this.path(id);
    const existed = await this.exists(id);
    const tmp = `${p}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    await Deno.writeFile(tmp, state, { mode: 0o600 });
    await Deno.rename(tmp, p);
    if (!existed) this.count++;
  }

  /** Refresh the mtime of a room someone opened (the TTL counts from the last visit, not the last edit). */
  async touch(id: string): Promise<void> {
    const now = new Date();
    await Deno.utime(this.path(id), now, now).catch(() => {});
  }

  async remove(id: string): Promise<void> {
    try {
      await Deno.remove(this.path(id));
      this.count = Math.max(0, this.count - 1);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }

  /**
   * Delete rooms not opened for `ttlDays` (and smoke-test rooms after an hour), except the ones in `keep`.
   * Returns how many were deleted.
   */
  async gc(ttlDays: number, keep: (id: string) => boolean, now = Date.now()): Promise<number> {
    let n = 0;
    let seen = 0;
    for await (const e of Deno.readDir(this.roomsDir)) {
      if (!e.isFile || !e.name.endsWith(".ydoc")) continue;
      seen++;
      const id = e.name.slice(0, -5);
      if (!isRoomId(id) || keep(id)) continue;
      const st = await Deno.stat(`${this.roomsDir}/${e.name}`).catch(() => null);
      const age = now - (st?.mtime?.getTime() ?? now);
      const ttl = id.startsWith("smoke-") ? 3600_000 : ttlDays * 86400_000;
      if (age > ttl) {
        await this.remove(id);
        n++;
      }
    }
    this.count = seen - n; // recount: files removed behind our back (smoke cleanup) are forgotten here
    return n;
  }

  /** Write + read back a probe file: the volume is mounted and writable (healthz capability). */
  async probe(): Promise<boolean> {
    const p = `${this.dataDir}/.healthz`;
    const v = `${Date.now()}`;
    try {
      await Deno.writeTextFile(p, v);
      return (await Deno.readTextFile(p)) === v;
    } catch {
      return false;
    }
  }
}
