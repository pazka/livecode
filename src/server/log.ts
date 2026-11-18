// JSON lines on stdout (box contract rule 8, hosh-management AGENTS.md section 11). Room ids are capability URLs:
// log `roomTag(id)`, never the id. Never log a request path, query string, body, IP, cookie or secret.

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let min: Level = "info";
let version = "dev";
let sink: (line: string) => void = (line) => console.log(line);

export function setLogLevel(l: string | undefined) {
  if (l && l in ORDER) min = l as Level;
}

/** The release tag put on every line (set once at startup from the config). */
export function setLogVersion(v: string) {
  version = v;
}

/** Where the lines go (stdout by default). Tests capture them; returns the previous sink. */
export function setLogSink(s: (line: string) => void): (line: string) => void {
  const prev = sink;
  sink = s;
  return prev;
}

export function logEnabled(level: Level): boolean {
  return ORDER[level] >= ORDER[min];
}

/** One line: ts, level, service, version, event (stable snake_case name), msg, then the fields. */
export function log(level: Level, event: string, msg: string, fields: Record<string, unknown> = {}) {
  if (!logEnabled(level)) return;
  sink(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      service: "livecode",
      version,
      event,
      msg,
      ...fields,
    }),
  );
}

/**
 * The `err` field of an error line: type, message and stack. A room id never reaches the log: each id in `hide`
 * and each room file name (`rooms/<id>.ydoc`, in file system errors) is replaced by its tag.
 */
export function errField(
  e: unknown,
  hide: string[] = [],
): { err: { type: string; message: string; stack?: string } } {
  const clean = (s: string) =>
    hide.reduce(
      (t, id) => t.replaceAll(id, roomTag(id)),
      s.replace(/rooms\/([^/\s'"]+?)\.ydoc/g, (_, id: string) => `rooms/${roomTag(id)}.ydoc`),
    );
  if (e instanceof Error) {
    return {
      err: { type: e.name, message: clean(e.message), ...(e.stack ? { stack: clean(e.stack) } : {}) },
    };
  }
  return { err: { type: typeof e, message: clean(String(e)) } };
}

/** A short non-reversible tag for a room id (FNV-1a), enough to follow one room through the logs. */
export function roomTag(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
