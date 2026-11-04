// JSON lines on stdout (box contract rule 8). Room ids are capability URLs: log `roomTag(id)`, never the id.

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let min: Level = "info";

export function setLogLevel(l: string | undefined) {
  if (l && l in ORDER) min = l as Level;
}

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  if (ORDER[level] < ORDER[min]) return;
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }));
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
